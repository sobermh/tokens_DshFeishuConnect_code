import assert from 'node:assert/strict'
import test from 'node:test'

import { TENANT_SCOPES, USER_SCOPES } from '../src/scopes.ts'

test('POS-13 bot can send messages in an authorized tenant', () => {
  assert.ok(TENANT_SCOPES.includes('im:message:send_as_bot'))
})

test('POS-14 bot can read wiki nodes needed by knowledge workflows', () => {
  assert.ok(TENANT_SCOPES.includes('wiki:node:read'))
})

test('POS-15 user can create and edit Feishu documents', () => {
  assert.ok(USER_SCOPES.includes('docx:document:create'))
  assert.ok(USER_SCOPES.includes('docx:document:write_only'))
})

test('POS-16 user can create and update Base records', () => {
  assert.ok(USER_SCOPES.includes('base:record:create'))
  assert.ok(USER_SCOPES.includes('base:record:update'))
})

test('POS-17 user can read and write task data', () => {
  assert.ok(USER_SCOPES.includes('task:task:read'))
  assert.ok(USER_SCOPES.includes('task:task:write'))
})

test('POS-18 refresh-token scope supports returning users', () => {
  assert.ok(USER_SCOPES.includes('offline_access'))
})

test('NEG-16 tenant grant excludes admin-only application patch permission', () => {
  assert.equal(TENANT_SCOPES.includes('application:application:patch'), false)
})

test('NEG-17 tenant grant excludes admin-only self-management permission', () => {
  assert.equal(TENANT_SCOPES.includes('application:application:self_manage'), false)
})

test('NEG-18 tenant scopes contain no duplicate grant', () => {
  assert.equal(new Set(TENANT_SCOPES).size, TENANT_SCOPES.length)
})

test('NEG-19 user scopes contain no duplicate grant', () => {
  assert.equal(new Set(USER_SCOPES).size, USER_SCOPES.length)
})

test('POS-38 tenant grants use normalized lowercase scope names', () => {
  assert.ok(TENANT_SCOPES.every((scope) => scope === scope.toLowerCase()))
})

test('POS-39 user grants use normalized lowercase scope names', () => {
  assert.ok(USER_SCOPES.every((scope) => scope === scope.toLowerCase()))
})

test('POS-40 personal identity can send ordinary messages', () => {
  assert.ok(USER_SCOPES.includes('im:message'))
})

test('POS-41 document workflows can read document content', () => {
  assert.ok(USER_SCOPES.includes('docs:document.content:read'))
})

test('POS-42 Base workflows can create and read apps', () => {
  assert.ok(USER_SCOPES.includes('base:app:create'))
  assert.ok(USER_SCOPES.includes('base:app:read'))
})

test('POS-43 drive workflows can upload and download files', () => {
  assert.ok(USER_SCOPES.includes('drive:file:upload'))
  assert.ok(USER_SCOPES.includes('drive:file:download'))
})

test('NEG-45 neither grant contains an empty scope', () => {
  assert.ok([...TENANT_SCOPES, ...USER_SCOPES].every((scope) => scope.length > 0))
})

test('NEG-46 neither grant contains surrounding whitespace', () => {
  assert.ok([...TENANT_SCOPES, ...USER_SCOPES].every((scope) => scope === scope.trim()))
})

test('NEG-47 neither grant uses wildcard permissions', () => {
  assert.ok([...TENANT_SCOPES, ...USER_SCOPES].every((scope) => !scope.includes('*')))
})
