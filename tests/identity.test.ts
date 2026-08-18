import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { assertLarkProfileName, identityFile } from '../src/identity.ts'

test('POS-33 default profile maps to one identity file below the runtime root', () => {
  const root = join('C:', 'isolated', 'lark-runtime')
  assert.equal(identityFile('dsh-feishu', root), join(root, 'dsh-feishu.identity.json'))
})

test('POS-34 team-specific alphanumeric profile names remain supported', () => {
  assert.doesNotThrow(() => assertLarkProfileName('sales_2026-prod'))
})

for (const [id, profile] of [
  ['NEG-34', '../victim'],
  ['NEG-35', '..\\victim'],
  ['NEG-36', 'team/child'],
  ['NEG-37', 'team\\child'],
  ['NEG-38', 'C:secret'],
  ['NEG-39', '.'],
  ['NEG-40', 'profile\nwith-control'],
  ['NEG-41', ''],
] as const) {
  test(`${id} rejects unsafe identity profile ${JSON.stringify(profile)}`, () => {
    assert.throws(() => identityFile(profile, join('C:', 'isolated')), /invalid profile name/)
  })
}

test('POS-53 human-readable Unicode profile names remain supported', () => {
  assert.doesNotThrow(() => assertLarkProfileName('销售团队 2026'))
})

test('NEG-53 Windows reserved device names are rejected', () => {
  assert.throws(() => assertLarkProfileName('CON'), /invalid profile name/)
})
