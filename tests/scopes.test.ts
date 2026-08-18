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
