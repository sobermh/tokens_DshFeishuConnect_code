/**
 * Materialize the official `lark-*` skills onto disk so custom sibling skills
 * (jky-*, approval flows) can `Read ../lark-shared/SKILL.md` and friends.
 *
 * The official skills are embedded in the lark-cli binary at build time and are
 * only exposed read-only through `lark-cli skills list` / `skills read`. Because
 * we materialize from the SAME binary the plugin just provisioned, the skill
 * content is always version-matched to the CLI — no hand-copying from GitHub,
 * no drift. Files are written under the user-global dsh skill root
 * (`$DSH_HOME/skills` or `~/.dsh/skills`), which the base skill loader watches
 * and hot-reloads, so a freshly materialized skill becomes discoverable without
 * a restart. A version-stamped manifest makes the whole thing idempotent and
 * self-healing: it re-materializes only when the binary version changes or the
 * sentinel `lark-shared/SKILL.md` goes missing, and it only ever touches the
 * skill directories it owns — never the user's own skills.
 * @module
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { ensureLarkcli, installedLarkVersion, probeLarkcli } from './larkcli-provision.ts'

const execFileP = promisify(execFile)

/** The skill every custom lark-* skill loads as its base; our self-heal sentinel. */
const SENTINEL = 'lark-shared'

/** Env that silences lark-cli's update/skills notices so output stays clean. */
const QUIET_ENV = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } as const

/** Non-secret manifest recording what this plugin materialized. */
interface SkillStamp {
  /** lark-cli version the skills were materialized from. */
  larkVersion: string
  /** Skill names this plugin owns (safe to prune on the next update). */
  skills: string[]
  /** ISO timestamp of the last materialization. */
  materializedAt: string
}

/** Summary returned to callers for logging. */
export interface SkillResult {
  version: string
  count: number
  root: string
  /** `true` when the cached materialization was reused (no work done). */
  skipped: boolean
}

/** User-global dsh skill root, resolved the same way the base loader does. */
function skillsRoot(): string {
  const home = process.env['DSH_HOME'] ? resolve(process.env['DSH_HOME']) : join(homedir(), '.dsh')
  return join(home, 'skills')
}

function stampFile(root: string): string {
  return join(root, '.lark-skills.json')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readStamp(root: string): Promise<SkillStamp | undefined> {
  try {
    return JSON.parse(await readFile(stampFile(root), 'utf8')) as SkillStamp
  } catch {
    return undefined
  }
}

async function writeStamp(root: string, stamp: SkillStamp): Promise<void> {
  await writeFile(stampFile(root), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 })
}

// ---- lark-cli invocation --------------------------------------------------

async function larkcli(bin: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileP(bin, [...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...QUIET_ENV },
  })
  return stdout
}

/** Parse a lark-cli JSON envelope leniently (notices may precede the body). */
function parseEnvelope(output: string): Record<string, unknown> {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('lark-cli skills: no JSON object in output')
  const map = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
  if (map['ok'] === false) {
    const error = map['error'] as { message?: unknown } | undefined
    const message = typeof error?.message === 'string' ? error.message : 'unknown error'
    throw new Error(`lark-cli skills: ${message}`)
  }
  return map
}

/** Names of all skills embedded in the binary. */
async function listNames(bin: string): Promise<string[]> {
  const map = parseEnvelope(await larkcli(bin, ['skills', 'list', '--json']))
  const skills = Array.isArray(map['skills']) ? map['skills'] : []
  return skills
    .map((s) => (typeof (s as { name?: unknown }).name === 'string' ? (s as { name: string }).name : ''))
    .filter((n) => n !== '')
}

/** Recursively enumerate all file entry paths under a skill (or subpath). */
async function listFiles(bin: string, path: string): Promise<string[]> {
  const map = parseEnvelope(await larkcli(bin, ['skills', 'list', path, '--json']))
  const entries = Array.isArray(map['entries']) ? map['entries'] : []
  const files: string[] = []
  for (const raw of entries) {
    const entry = raw as { path?: unknown; is_dir?: unknown }
    if (typeof entry.path !== 'string' || entry.path === '') continue
    if (entry.is_dir === true) files.push(...(await listFiles(bin, entry.path)))
    else files.push(entry.path)
  }
  return files
}

/** Materialize every file of one skill under `<root>/<name>/…`. */
async function materializeSkill(bin: string, root: string, name: string): Promise<void> {
  const base = resolve(root, name)
  for (const entryPath of await listFiles(bin, name)) {
    // `skills read` accepts the full slash-form path; entries include the skill
    // name as a prefix, which we strip to get the on-disk relative path.
    const rel = entryPath.startsWith(`${name}/`) ? entryPath.slice(name.length + 1) : entryPath
    const dest = resolve(base, rel)
    if (dest !== base && !dest.startsWith(base + sep)) {
      throw new Error(`lark-cli skills: entry escapes skill dir: ${entryPath}`)
    }
    const content = await larkcli(bin, ['skills', 'read', entryPath])
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content, 'utf8')
  }
}

/** Remove skill dirs we previously owned that upstream no longer ships. */
async function pruneRemoved(root: string, oldNames: readonly string[], newNames: readonly string[]): Promise<void> {
  const keep = new Set(newNames)
  for (const name of oldNames) {
    if (!keep.has(name)) await rm(join(root, name), { recursive: true, force: true })
  }
}

/**
 * Ensure all official lark-* skills are materialized on disk, version-aligned
 * with the provisioned binary. Idempotent: reuses the cached materialization
 * unless the binary version changed, the sentinel skill is missing, or `force`
 * is set. Only manages the lark-* skill dirs it owns; never touches user skills.
 * @param force - re-materialize even when the version stamp already matches.
 * @returns a summary of what happened (for logging).
 */
export async function ensureSkills(force = false): Promise<SkillResult> {
  const bin = await ensureLarkcli()
  const version = (await installedLarkVersion()) ?? probeLarkcli(bin) ?? 'unknown'
  const root = skillsRoot()
  await mkdir(root, { recursive: true })

  const stamp = await readStamp(root)
  const sentinelOk = await fileExists(join(root, SENTINEL, 'SKILL.md'))
  if (!force && stamp?.larkVersion === version && sentinelOk) {
    return { version, count: stamp.skills.length, root, skipped: true }
  }

  const names = await listNames(bin)
  // Materialize the sentinel first so a mid-way failure still fixes the loop.
  const ordered = [...names].sort((a, b) => (a === SENTINEL ? -1 : b === SENTINEL ? 1 : 0))
  for (const name of ordered) {
    await materializeSkill(bin, root, name)
  }

  if (stamp !== undefined) await pruneRemoved(root, stamp.skills, names)
  await writeStamp(root, { larkVersion: version, skills: names, materializedAt: new Date().toISOString() })
  return { version, count: names.length, root, skipped: false }
}
