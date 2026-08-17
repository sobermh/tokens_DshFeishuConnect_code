/**
 * Supply-chain-pinned acquisition of the official Larksuite CLI
 * (`github.com/larksuite/cli`). The connect flow drives lark-cli's built-in
 * device-code login, so the plugin must ship a verified copy of that native
 * binary. Ported from the TokensAgent `provision_binary.go` pin registry:
 * every platform maps to one pinned GitHub-release archive with a SHA-256 for
 * both the archive and the extracted binary. Nothing here is configurable —
 * changing a URL/hash/version is a reviewed code change, never plugin config.
 *
 * Node has no built-in zip/tar reader and the plugin carries no dependencies,
 * so the two archive formats are unpacked by the minimal readers below. The
 * pinned binary SHA-256 is the authoritative gate: a tampered archive can never
 * produce bytes that match it, so the extractors only need to locate the entry.
 * @module
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

/** One platform's pinned supply-chain metadata. */
interface Pin {
  /** Release version, for status messages. */
  version: string
  /** Pinned https download URL (github.com release asset). */
  url: string
  /** Expected SHA-256 (hex) of the downloaded archive. */
  archiveSha256: string
  /** Expected archive byte size. */
  archiveSize: number
  /** Archive container format. */
  archiveFormat: 'zip' | 'tar.gz'
  /** Name of the binary entry inside the archive. */
  archiveEntry: string
  /** Expected SHA-256 (hex) of the extracted binary. */
  binarySha256: string
  /** Expected binary byte size. */
  binarySize: number
  /** Filename to install the binary under. */
  targetName: string
  /** Hostnames the download (and its redirects) may resolve to. */
  allowedHosts: readonly string[]
}

const RELEASE = 'https://github.com/larksuite/cli/releases/download/v1.0.76'
const GITHUB_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] as const

/** Pinned lark-cli v1.0.76 releases, keyed by Node `${platform}-${arch}`. */
const PINS: Record<string, Pin> = {
  'win32-x64': {
    version: 'v1.0.76',
    url: `${RELEASE}/lark-cli-1.0.76-windows-amd64.zip`,
    archiveSha256: 'cf59dcf3224a0753b1b11cae14f0513242ef7eab02f9c7d35c26427647ed6145',
    archiveSize: 12702219,
    archiveFormat: 'zip',
    archiveEntry: 'lark-cli.exe',
    binarySha256: 'f3a280bce52b8cc57d027385762c8f6379411eac500c83c49395d63645be759e',
    binarySize: 44323840,
    targetName: 'lark-cli.exe',
    allowedHosts: GITHUB_HOSTS,
  },
  'linux-x64': {
    version: 'v1.0.76',
    url: `${RELEASE}/lark-cli-1.0.76-linux-amd64.tar.gz`,
    archiveSha256: '759a676dde001bdc015384cfd741bcaca873329bbcaad8c4ea4a06acb49b3f42',
    archiveSize: 12312501,
    archiveFormat: 'tar.gz',
    archiveEntry: 'lark-cli',
    binarySha256: '21c25bbda5b7fdc9b8f5344954f69427042ec7a4e175d655c50515467553a92e',
    binarySize: 43102360,
    targetName: 'lark-cli',
    allowedHosts: GITHUB_HOSTS,
  },
  'darwin-x64': {
    version: 'v1.0.76',
    url: `${RELEASE}/lark-cli-1.0.76-darwin-amd64.tar.gz`,
    archiveSha256: 'f13c35b4a2a83d0c32b4ab3c223357cacffa341f621a112ca51e01f80826782a',
    archiveSize: 12661985,
    archiveFormat: 'tar.gz',
    archiveEntry: 'lark-cli',
    binarySha256: '6e44c38fb6771d9b885edfe36b29538471f050a01b0468155f49b62243a8a9e5',
    binarySize: 44326848,
    targetName: 'lark-cli',
    allowedHosts: GITHUB_HOSTS,
  },
  'darwin-arm64': {
    version: 'v1.0.76',
    url: `${RELEASE}/lark-cli-1.0.76-darwin-arm64.tar.gz`,
    archiveSha256: '6d9776cbde1b7d6a23c7279364578df2d5ea54cdbb041951d97b68567bce8cc8',
    archiveSize: 12216145,
    archiveFormat: 'tar.gz',
    archiveEntry: 'lark-cli',
    binarySha256: '95bdd996ca4a8071ccac14f1542c9509557eb8f7091dd489e51139ef8aa1be80',
    binarySize: 43373090,
    targetName: 'lark-cli',
    allowedHosts: GITHUB_HOSTS,
  },
}

const MAX_ARCHIVE_SIZE = 16 * 1024 * 1024
const MAX_BINARY_SIZE = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000

function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

function pinForHost(): Pin {
  const key = `${platform()}-${arch()}`
  const pin = PINS[key]
  if (pin === undefined) {
    throw new Error(`lark-cli: no pinned binary for this platform (${key}); supported: ${Object.keys(PINS).join(', ')}`)
  }
  return pin
}

/** Directory holding the managed lark-cli binary (per-user, persistent). */
function binDir(): string {
  return join(homedir(), '.dsh', 'runtime', 'lark-cli')
}

async function fileMatches(path: string, size: number, hash: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== size) return false
    return sha256(await readFile(path)) === hash
  } catch {
    return false
  }
}

/**
 * Return the path to an already-installed, hash-verified lark-cli binary, or
 * `undefined` if it is not present. Never downloads — callers use this to probe
 * status without triggering a 12 MB fetch.
 * @returns the verified binary path, or `undefined`.
 */
export async function larkcliPath(): Promise<string | undefined> {
  let pin: Pin
  try {
    pin = pinForHost()
  } catch {
    return undefined
  }
  const target = join(binDir(), pin.targetName)
  return (await fileMatches(target, pin.binarySize, pin.binarySha256)) ? target : undefined
}

// ---- pinned download ------------------------------------------------------

async function download(pin: Pin): Promise<Buffer> {
  const initial = new URL(pin.url)
  if (initial.protocol !== 'https:' || !pin.allowedHosts.includes(initial.hostname)) {
    throw new Error('lark-cli: refusing to download from an untrusted URL')
  }
  const response = await fetch(pin.url, {
    redirect: 'follow',
    headers: { 'user-agent': 'dsh-feishu-larkcli/1' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`lark-cli: download failed (HTTP ${response.status})`)
  try {
    const finalHost = new URL(response.url).hostname
    if (finalHost !== '' && !pin.allowedHosts.includes(finalHost)) {
      throw new Error('lark-cli: download redirected to an untrusted host')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('untrusted')) throw error
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_ARCHIVE_SIZE) throw new Error('lark-cli: downloaded archive is too large')
  return Buffer.from(bytes)
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

async function install(pin: Pin, target: string): Promise<string> {
  const archive = await download(pin)
  if (archive.length !== pin.archiveSize) throw new Error('lark-cli: downloaded archive size mismatch')
  if (sha256(archive) !== pin.archiveSha256) throw new Error('lark-cli: downloaded archive checksum mismatch')

  const binary = pin.archiveFormat === 'zip'
    ? extractZipEntry(archive, pin.archiveEntry)
    : extractTarGzEntry(archive, pin.archiveEntry)
  if (binary.length !== pin.binarySize) throw new Error('lark-cli: extracted binary size mismatch')
  if (sha256(binary) !== pin.binarySha256) throw new Error('lark-cli: extracted binary checksum mismatch')

  const staging = join(binDir(), `.lark-cli-${pin.binarySize}.part`)
  await writeFile(staging, binary, { mode: 0o700 })
  await rename(staging, target) // atomic within the same directory
  await chmod(target, 0o700).catch(() => {})
  return target
}

async function doEnsure(): Promise<string> {
  const pin = pinForHost()
  await mkdir(binDir(), { recursive: true })
  const target = join(binDir(), pin.targetName)
  if (await fileMatches(target, pin.binarySize, pin.binarySha256)) {
    await chmod(target, 0o700).catch(() => {})
    return target
  }
  return install(pin, target)
}

/**
 * Ensure a hash-verified lark-cli binary is installed, downloading and
 * extracting the pinned release on first use, and return its path. Concurrent
 * calls share one install; a failure clears the cache so the next call retries.
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
 * Quick self-check that the installed binary runs (`lark-cli --version`).
 * @param bin - path to the binary.
 * @returns the reported version line, or `undefined` if it did not run.
 */
export function probeLarkcli(bin: string): string | undefined {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  if (result.status !== 0) return undefined
  return `${result.stdout}${result.stderr}`.trim() || undefined
}
