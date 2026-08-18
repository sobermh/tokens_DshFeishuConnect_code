/**
 * Persist a small, non-secret record of the connected Feishu identity so the
 * plugin recognizes an existing connection across restarts and can name who is
 * connected without shelling out — and so sibling skills can discover which
 * lark-cli profile to reuse. The user token itself is NEVER written here:
 * lark-cli keeps that in the OS keychain and remains the single source of truth
 * for validity. This file is a convenience cache of identity metadata only
 * (display name, masked open id, profile, timestamp), living next to the
 * managed lark-cli binary.
 * @module
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Windows-invalid filename characters plus path separators and controls. */
const INVALID_PROFILE_CHARS = /[<>:"/\\|?*\u0000-\u001F]/
const WINDOWS_RESERVED_PROFILE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** Non-secret identity metadata cached alongside the lark-cli runtime. */
export interface IdentityRecord {
  /** lark-cli profile the session lives under. */
  profile: string
  /** ISO timestamp of the last successful connect. */
  connectedAt: string
  /** Display name of the authorized user, when lark-cli reported one. */
  userName?: string
  /** Masked open id of the authorized user, when reported. */
  openId?: string
}

/** Directory holding the managed lark-cli binary and this cache (per-user). */
function dir(): string {
  return join(homedir(), '.dsh', 'runtime', 'lark-cli')
}

/** Reject configured profile names that could escape or confuse the cache dir. */
export function assertLarkProfileName(profile: string): void {
  if (profile.length < 1 || profile.length > 64
    || profile === '.' || profile === '..'
    || INVALID_PROFILE_CHARS.test(profile)
    || /[ .]$/.test(profile)
    || WINDOWS_RESERVED_PROFILE.test(profile)) {
    throw new Error(`lark-cli: invalid profile name: ${profile}`)
  }
}

/** Resolve the identity cache file and prove it stays under the runtime root. */
export function identityFile(profile: string, root = dir()): string {
  assertLarkProfileName(profile)
  const safeRoot = resolve(root)
  const target = resolve(safeRoot, `${profile}.identity.json`)
  if (!target.startsWith(safeRoot + sep)) {
    throw new Error(`lark-cli: identity path escapes runtime root: ${profile}`)
  }
  return target
}

/**
 * Read the cached identity for a profile.
 * @param profile - lark-cli profile name.
 * @returns the stored record, or `undefined` if none is present or unreadable.
 */
export async function readIdentity(profile: string): Promise<IdentityRecord | undefined> {
  try {
    return JSON.parse(await readFile(identityFile(profile), 'utf8')) as IdentityRecord
  } catch {
    return undefined
  }
}

/**
 * Write the cached identity for a profile (non-secret metadata only).
 * @param record - the identity metadata to persist.
 */
export async function writeIdentity(record: IdentityRecord): Promise<void> {
  const target = identityFile(record.profile)
  await mkdir(dir(), { recursive: true })
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Remove the cached identity for a profile (e.g. after logout). Idempotent.
 * @param profile - lark-cli profile name.
 */
export async function clearIdentity(profile: string): Promise<void> {
  await rm(identityFile(profile), { force: true })
}
