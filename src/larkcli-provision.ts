/**
 * Self-maintaining acquisition of the official Larksuite CLI
 * (`github.com/larksuite/cli`). The connect flow drives lark-cli's built-in
 * device-code login, so the plugin must ship a verified copy of that native
 * binary — and keep it current without a code change on every upstream release.
 *
 * Instead of a hardcoded version + pinned hash, this tracks the latest GitHub
 * release: resolve `releases/latest` → download that release's own
 * `checksums.txt` → verify the platform archive's SHA-256 against it → extract
 * → install atomically, stamping the installed tag so a cached binary is reused
 * until a newer release appears (that is how "auto-update" happens). Integrity
 * is gated by the release's signed-over-TLS checksum manifest rather than a
 * baked-in constant; a `MIN_VERSION` floor rejects a downgrade. When the network
 * is unavailable the already-installed binary is reused rather than failing.
 *
 * Node has no built-in zip/tar reader and the plugin carries no dependencies, so
 * the two archive formats are unpacked by the minimal readers below. The
 * checksum on the downloaded archive is the authoritative gate; the extractors
 * only need to locate the entry.
 * @module
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

const REPO = 'larksuite/cli'
const GITHUB_API = 'https://api.github.com'
/** Hostnames any fetch (and its redirects) may resolve to. */
const GITHUB_HOSTS = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const

/**
 * Lowest release the plugin will install. Guards against an upstream downgrade
 * or a poisoned "latest" pointing at an ancient tag; this is the last version
 * the plugin was validated against. Bumping it is a reviewed code change.
 */
const MIN_VERSION = '1.0.76'

const MAX_ARCHIVE_SIZE = 24 * 1024 * 1024
const MAX_BINARY_SIZE = 96 * 1024 * 1024
const MAX_META_SIZE = 4 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000

/** Resolved per-platform release-asset shape. */
interface PlatformInfo {
  /** Release OS token (`windows` / `linux` / `darwin`). */
  os: 'windows' | 'linux' | 'darwin'
  /** Release CPU token (`amd64` / `arm64`). */
  arch: 'amd64' | 'arm64'
  /** Archive container format for this OS. */
  format: 'zip' | 'tar.gz'
  /** Binary entry name inside the archive, and install filename. */
  entry: string
}

/** One resolved GitHub release: its tag and asset name → download URL map. */
interface Release {
  /** Normalized tag, e.g. `v1.0.87`. */
  tag: string
  /** Asset filename → browser_download_url. */
  assets: Map<string, string>
}

function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Map the running Node platform/arch to the release's asset naming. */
function platformInfo(): PlatformInfo {
  const p = platform()
  const a = arch()
  const os = p === 'win32' ? 'windows' : p === 'darwin' ? 'darwin' : p === 'linux' ? 'linux' : undefined
  const cpu = a === 'x64' ? 'amd64' : a === 'arm64' ? 'arm64' : undefined
  if (os === undefined || cpu === undefined) {
    throw new Error(`lark-cli: unsupported platform (${p}-${a})`)
  }
  const format = os === 'windows' ? 'zip' : 'tar.gz'
  const entry = os === 'windows' ? 'lark-cli.exe' : 'lark-cli'
  return { os, arch: cpu, format, entry }
}

/** Directory holding the managed lark-cli binary and its version stamp (per-user). */
function binDir(): string {
  return join(homedir(), '.dsh', 'runtime', 'lark-cli')
}

function stampFile(): string {
  return join(binDir(), '.lark-cli-version')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readStamp(): Promise<string | undefined> {
  try {
    return (await readFile(stampFile(), 'utf8')).trim() || undefined
  } catch {
    return undefined
  }
}

async function writeStamp(tag: string): Promise<void> {
  await writeFile(stampFile(), `${tag}\n`, { mode: 0o600 })
}

/** Compare `a` vs `b` numerically on their first three dotted components. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split(/[.\-+]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Filename of the archive asset for the current platform at a given tag. */
function assetName(info: PlatformInfo, tag: string): string {
  const ver = tag.replace(/^v/, '')
  return `lark-cli-${ver}-${info.os}-${info.arch}.${info.format}`
}

// ---- network (host-allowlisted) -------------------------------------------

async function httpBytes(url: string, maxBytes: number): Promise<Buffer> {
  const initial = new URL(url)
  if (initial.protocol !== 'https:' || !GITHUB_HOSTS.includes(initial.hostname as (typeof GITHUB_HOSTS)[number])) {
    throw new Error('lark-cli: refusing to fetch from an untrusted URL')
  }
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'dsh-feishu-larkcli/2', accept: 'application/octet-stream, application/vnd.github+json' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`lark-cli: fetch failed (HTTP ${response.status})`)
  try {
    const finalHost = new URL(response.url).hostname
    if (finalHost !== '' && !GITHUB_HOSTS.includes(finalHost as (typeof GITHUB_HOSTS)[number])) {
      throw new Error('lark-cli: fetch redirected to an untrusted host')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('untrusted')) throw error
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > maxBytes) throw new Error('lark-cli: fetched resource is too large')
  return Buffer.from(bytes)
}

// ---- latest-release resolution (memoized per process) ---------------------

let latestMemo: Promise<Release> | undefined

async function fetchLatest(): Promise<Release> {
  const buf = await httpBytes(`${GITHUB_API}/repos/${REPO}/releases/latest`, MAX_META_SIZE)
  const data = JSON.parse(buf.toString('utf8')) as { tag_name?: unknown; assets?: unknown }
  const rawTag = typeof data.tag_name === 'string' ? data.tag_name : ''
  if (!/^v?\d+\.\d+\.\d+/.test(rawTag)) throw new Error('lark-cli: could not resolve latest release tag')
  if (compareVersions(rawTag, MIN_VERSION) < 0) {
    throw new Error(`lark-cli: latest release ${rawTag} is below the minimum supported ${MIN_VERSION}`)
  }
  const assets = new Map<string, string>()
  if (Array.isArray(data.assets)) {
    for (const asset of data.assets) {
      const name = (asset as { name?: unknown }).name
      const dl = (asset as { browser_download_url?: unknown }).browser_download_url
      if (typeof name === 'string' && typeof dl === 'string') assets.set(name, dl)
    }
  }
  const tag = rawTag.startsWith('v') ? rawTag : `v${rawTag}`
  return { tag, assets }
}

/** Resolve the latest release once per process; failures clear the memo. */
function resolveLatest(): Promise<Release> {
  if (latestMemo === undefined) {
    latestMemo = fetchLatest().catch((error: unknown) => {
      latestMemo = undefined
      throw error
    })
  }
  return latestMemo
}

/** Parse `sha256␠␠[*]name` lines from a checksums manifest. */
function checksumFor(manifest: string, name: string): string {
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (match !== null && match[2]!.trim() === name) return match[1]!.toLowerCase()
  }
  throw new Error(`lark-cli: ${name} not listed in checksums.txt`)
}

// ---- minimal archive readers ----------------------------------------------

const ZIP_EOCD_SIG = 0x06054b50
const ZIP_CD_SIG = 0x02014b50
const ZIP_LOCAL_SIG = 0x04034b50

/** Extract one entry from a ZIP archive (stored or DEFLATE). */
function extractZipEntry(zip: Buffer, entryName: string): Buffer {
  let eocd = -1
  const floor = Math.max(0, zip.length - 22 - 0xffff)
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === ZIP_EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('lark-cli: zip end-of-central-directory not found')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== ZIP_CD_SIG) throw new Error('lark-cli: corrupt zip central directory')
    const method = zip.readUInt16LE(p + 10)
    const compSize = zip.readUInt32LE(p + 20)
    const uncompSize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOff = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === entryName) {
      if (uncompSize > MAX_BINARY_SIZE) throw new Error('lark-cli: zip entry is too large')
      if (zip.readUInt32LE(localOff) !== ZIP_LOCAL_SIG) throw new Error('lark-cli: corrupt zip local header')
      const dataStart = localOff + 30 + zip.readUInt16LE(localOff + 26) + zip.readUInt16LE(localOff + 28)
      const compressed = zip.subarray(dataStart, dataStart + compSize)
      const out = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
      if (out.length !== uncompSize) throw new Error('lark-cli: zip entry size mismatch after inflate')
      return out
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`lark-cli: entry ${entryName} not found in zip`)
}

/** Extract one regular-file entry from a gzip-compressed tar archive. */
function extractTarGzEntry(archive: Buffer, entryName: string): Buffer {
  const tar = gunzipSync(archive)
  let off = 0
  while (off + 512 <= tar.length) {
    const nameField = tar.subarray(off, off + 100)
    const nul = nameField.indexOf(0)
    const name = nameField.toString('utf8', 0, nul < 0 ? 100 : nul)
    if (name === '') break // zero block terminates the archive
    const sizeField = tar.toString('ascii', off + 124, off + 136).replace(/\0.*$/, '').trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0 || size > MAX_BINARY_SIZE) {
      throw new Error('lark-cli: invalid tar entry size')
    }
    const typeflag = tar.toString('ascii', off + 156, off + 157)
    const dataStart = off + 512
    if ((typeflag === '0' || typeflag === '\0' || typeflag === '') && (name === entryName || name === `./${entryName}`)) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size))
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  throw new Error(`lark-cli: entry ${entryName} not found in tar.gz`)
}

// ---- install (single-flight) ----------------------------------------------

let ensureInFlight: Promise<string> | undefined

async function install(info: PlatformInfo, release: Release, target: string): Promise<string> {
  const name = assetName(info, release.tag)
  const assetUrl = release.assets.get(name)
  if (assetUrl === undefined) throw new Error(`lark-cli: release ${release.tag} has no asset ${name}`)
  const sumsUrl = release.assets.get('checksums.txt')
  if (sumsUrl === undefined) throw new Error(`lark-cli: release ${release.tag} has no checksums.txt`)

  const manifest = (await httpBytes(sumsUrl, MAX_META_SIZE)).toString('utf8')
  const expected = checksumFor(manifest, name)

  const archive = await httpBytes(assetUrl, MAX_ARCHIVE_SIZE)
  if (sha256(archive) !== expected) throw new Error('lark-cli: downloaded archive checksum mismatch')

  const binary = info.format === 'zip'
    ? extractZipEntry(archive, info.entry)
    : extractTarGzEntry(archive, info.entry)
  if (binary.length > MAX_BINARY_SIZE) throw new Error('lark-cli: extracted binary is too large')

  const staging = join(binDir(), `.lark-cli-${process.pid}.part`)
  await writeFile(staging, binary, { mode: 0o700 })
  await rename(staging, target) // atomic within the same directory
  await chmod(target, 0o700).catch(() => {})
  await writeStamp(release.tag)
  return target
}

async function doEnsure(): Promise<string> {
  const info = platformInfo()
  await mkdir(binDir(), { recursive: true })
  const target = join(binDir(), info.entry)

  let release: Release
  try {
    release = await resolveLatest()
  } catch (error) {
    // Offline / rate-limited: reuse an already-installed binary rather than fail.
    if (await fileExists(target)) {
      await chmod(target, 0o700).catch(() => {})
      return target
    }
    throw error
  }

  if ((await readStamp()) === release.tag && (await fileExists(target))) {
    await chmod(target, 0o700).catch(() => {})
    return target
  }
  return install(info, release, target)
}

/**
 * Ensure an up-to-date, checksum-verified lark-cli binary is installed,
 * downloading the latest release on first use or when a newer one is available,
 * and return its path. Concurrent calls share one install; a failure clears the
 * cache so the next call retries.
 * @returns the path to the verified lark-cli binary.
 */
export function ensureLarkcli(): Promise<string> {
  if (ensureInFlight === undefined) {
    ensureInFlight = doEnsure().catch((error: unknown) => {
      ensureInFlight = undefined
      throw error
    })
  }
  return ensureInFlight
}

/**
 * Return the path to an already-installed lark-cli binary without any network
 * access, or `undefined` if none is present. Integrity was verified against the
 * release checksum manifest at install time; callers use this to probe status
 * without triggering a download.
 * @returns the installed binary path, or `undefined`.
 */
export async function larkcliPath(): Promise<string | undefined> {
  let info: PlatformInfo
  try {
    info = platformInfo()
  } catch {
    return undefined
  }
  const target = join(binDir(), info.entry)
  return (await fileExists(target)) ? target : undefined
}

/**
 * The release tag of the currently installed binary (from the version stamp),
 * or `undefined` if unknown. Used to align materialized skills with the binary.
 * @returns the installed release tag (e.g. `v1.0.87`), or `undefined`.
 */
export function installedLarkVersion(): Promise<string | undefined> {
  return readStamp()
}

/**
 * Quick self-check that the installed binary runs (`lark-cli --version`).
 * @param bin - path to the binary.
 * @returns the reported version line, or `undefined` if it did not run.
 */
export function probeLarkcli(bin: string): string | undefined {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  if (result.status !== 0) return undefined
  return `${result.stdout}${result.stderr}`.trim() || undefined
}
