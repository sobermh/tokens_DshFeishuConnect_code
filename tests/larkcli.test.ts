import assert from 'node:assert/strict'
import test from 'node:test'

import { configInitArgs, createLarkcli } from '../src/larkcli.ts'

test('POS-01 China tenant initializes the Feishu route', () => {
  const args = configInitArgs('cli_a123', 'dsh-feishu', 'feishu')
  assert.equal(args[args.indexOf('--brand') + 1], 'feishu')
})

test('POS-02 international tenant initializes the Lark route', () => {
  const args = configInitArgs('cli_a123', 'dsh-lark', 'lark')
  assert.equal(args[args.indexOf('--brand') + 1], 'lark')
})

test('POS-03 app id and profile are preserved as individual argv values', () => {
  const args = configInitArgs('cli app with spaces', 'sales team profile', 'feishu')
  assert.equal(args[args.indexOf('--app-id') + 1], 'cli app with spaces')
  assert.equal(args[args.indexOf('--name') + 1], 'sales team profile')
})

test('POS-04 existing profiles are deliberately replaced during reconnect', () => {
  const args = configInitArgs('cli_a123', 'dsh-feishu', 'feishu')
  assert.ok(args.includes('--force-init'))
})

test('POS-05 app secret is requested through stdin', () => {
  const args = configInitArgs('cli_a123', 'dsh-feishu', 'feishu')
  assert.ok(args.includes('--app-secret-stdin'))
})

test('NEG-01 app secret is never represented by a command-line flag', () => {
  const args = configInitArgs('cli_a123', 'dsh-feishu', 'feishu')
  assert.equal(args.includes('--app-secret'), false)
  assert.equal(args.includes('app-secret'), false)
})

test('NEG-02 suspicious app id text cannot become an extra argv flag', () => {
  const injected = 'cli_a123 --brand lark'
  const args = configInitArgs(injected, 'dsh-feishu', 'feishu')
  assert.equal(args.filter((value) => value === '--brand').length, 1)
  assert.equal(args[args.indexOf('--app-id') + 1], injected)
})

test('POS-51 CLI client accepts the default safe profile', () => {
  assert.doesNotThrow(() => createLarkcli({ profile: 'dsh-feishu', baseURL: 'https://open.feishu.cn' }))
})

test('NEG-51 CLI client rejects a path-like configured profile immediately', () => {
  assert.throws(
    () => createLarkcli({ profile: '../other-profile', baseURL: 'https://open.feishu.cn' }),
    /invalid profile name/,
  )
})
