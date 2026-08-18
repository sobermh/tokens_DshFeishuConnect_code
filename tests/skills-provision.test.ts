import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertManagedSkillName, managedSkillDir, pruneRemoved } from '../src/skills-provision.ts'

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

for (const [id, name] of [
  ['POS-06', 'lark-shared'],
  ['POS-07', 'lark-workflow-standup-report'],
  ['POS-08', 'lark-docx-v2'],
] as const) {
  test(`${id} accepts official single-segment skill ${name}`, () => {
    assert.doesNotThrow(() => assertManagedSkillName(name))
  })
}

test('POS-09 managed skill directory stays below the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-skills-root-'))
  try {
    assert.equal(managedSkillDir(root, 'lark-shared'), join(root, 'lark-shared'))
    assert.throws(() => managedSkillDir(root, '../victim'), /invalid managed skill name/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('NEG-03 forged ownership names cannot delete outside skillsRoot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-skills-boundary-'))
  const root = join(home, 'skills')
  const victim = join(home, 'victim-do-not-delete')
  await mkdir(root, { recursive: true })
  await mkdir(victim, { recursive: true })
  await writeFile(join(victim, 'marker.txt'), 'keep', 'utf8')
  try {
    await assert.rejects(pruneRemoved(root, ['../victim-do-not-delete'], []), /invalid managed skill name/)
    assert.equal(await exists(victim), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('POS-10 an upstream-removed official skill is pruned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-skills-prune-'))
  const root = join(home, 'skills')
  const removed = join(root, 'lark-old')
  const kept = join(root, 'lark-shared')
  await mkdir(removed, { recursive: true })
  await mkdir(kept, { recursive: true })
  try {
    await pruneRemoved(root, ['lark-old', 'lark-shared'], ['lark-shared'])
    assert.equal(await exists(removed), false)
    assert.equal(await exists(kept), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('POS-11 a skill still shipped upstream is preserved', async () => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-skills-keep-'))
  const root = join(home, 'skills')
  const kept = join(root, 'lark-shared')
  await mkdir(kept, { recursive: true })
  try {
    await pruneRemoved(root, ['lark-shared'], ['lark-shared'])
    assert.equal(await exists(kept), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('POS-12 first install with no old ownership stamp is a no-op prune', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-skills-first-install-'))
  try {
    await assert.doesNotReject(pruneRemoved(root, [], ['lark-shared']))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const [id, name] of [
  ['NEG-04', '../victim'],
  ['NEG-05', '..\\victim'],
  ['NEG-06', 'lark/child'],
  ['NEG-07', 'lark\\child'],
  ['NEG-08', 'lark-..'],
  ['NEG-09', 'other-skill'],
  ['NEG-10', 'lark_UPPER'],
  ['NEG-11', 'LARK-shared'],
  ['NEG-12', 'lark--shared'],
  ['NEG-13', 'lark-shared.exe'],
  ['NEG-14', 'lark-shared '],
  ['NEG-15', ''],
] as const) {
  test(`${id} rejects unsafe managed skill name ${JSON.stringify(name)}`, () => {
    assert.throws(() => assertManagedSkillName(name), /invalid managed skill name/)
  })
}
