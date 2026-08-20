import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'

import { beginRegistration, pollRegistration, type RegisterOptions, type RegisterSession } from '../src/register.ts'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function options(domain: 'feishu' | 'lark' = 'feishu'): RegisterOptions {
  return {
    domain,
    appName: '销售周报助手',
    appDesc: '汇总销售团队的飞书周报',
    tenantScopes: ['im:message:send_as_bot'],
    userScopes: ['docx:document:create', 'offline_access'],
  }
}

function session(overrides: Partial<RegisterSession> = {}): RegisterSession {
  return {
    deviceCode: 'device-123',
    host: 'accounts.feishu.cn',
    intervalSec: 5,
    expiresAt: Date.now() + 60_000,
    switched: false,
    qrUrl: 'https://accounts.feishu.cn/confirm',
    ...overrides,
  }
}

async function withFetch(
  implementation: typeof fetch,
  action: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = implementation
  try { await action() } finally { globalThis.fetch = originalFetch }
}

test('registration business scenarios', { concurrency: false }, async (t) => {
  await t.test('POS-19 China user receives a Feishu app-creation link', async () => {
    await withFetch(async (input) => {
      assert.match(String(input), /^https:\/\/accounts\.feishu\.cn\//)
      return jsonResponse({ device_code: 'cn-device', verification_uri_complete: 'https://accounts.feishu.cn/confirm' })
    }, async () => {
      const result = await beginRegistration(options())
      assert.equal(result.host, 'accounts.feishu.cn')
      assert.equal(result.deviceCode, 'cn-device')
    })
  })

  await t.test('POS-20 international user receives a Lark app-creation link', async () => {
    await withFetch(async (input) => {
      assert.match(String(input), /^https:\/\/accounts\.larksuite\.com\//)
      return jsonResponse({ device_code: 'global-device', verification_uri_complete: 'https://accounts.larksuite.com/confirm' })
    }, async () => {
      const result = await beginRegistration(options('lark'))
      assert.equal(result.host, 'accounts.larksuite.com')
    })
  })

  await t.test('POS-51 current Feishu launcher confirmation host is accepted', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'cn-device', verification_uri_complete: 'https://open.feishu.cn/page/launcher',
    }), async () => {
      const result = await beginRegistration(options())
      assert.equal(new URL(result.qrUrl).hostname, 'open.feishu.cn')
    })
  })

  await t.test('POS-52 current Lark launcher confirmation host is accepted', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'global-device', verification_uri_complete: 'https://open.larksuite.com/page/launcher',
    }), async () => {
      const result = await beginRegistration(options('lark'))
      assert.equal(new URL(result.qrUrl).hostname, 'open.larksuite.com')
    })
  })

  await t.test('POS-21 confirmation link contains the requested app identity', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm?existing=1',
    }), async () => {
      const result = await beginRegistration(options())
      const url = new URL(result.qrUrl)
      assert.equal(url.searchParams.get('name'), '销售周报助手')
      assert.equal(url.searchParams.get('desc'), '汇总销售团队的飞书周报')
      assert.equal(url.searchParams.get('source'), 'dsh-feishu')
    })
  })

  await t.test('POS-22 confirmation link carries the exact tenant and user grants', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm',
    }), async () => {
      const result = await beginRegistration(options())
      const addons = new URL(result.qrUrl).searchParams.get('addons')
      assert.ok(addons)
      const decoded = JSON.parse(gunzipSync(Buffer.from(addons, 'base64url')).toString('utf8'))
      assert.deepEqual(decoded, { scopes: {
        tenant: ['im:message:send_as_bot'],
        user: ['docx:document:create', 'offline_access'],
      } })
    })
  })

  await t.test('POS-23 server-supplied polling interval and expiry are honored', async () => {
    const before = Date.now()
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm', interval: 9, expires_in: 120,
    }), async () => {
      const result = await beginRegistration(options())
      assert.equal(result.intervalSec, 9)
      assert.ok(result.expiresAt >= before + 119_000)
    })
  })

  await t.test('POS-24 invalid zero timing values fall back to safe defaults', async () => {
    const before = Date.now()
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm', interval: 0, expires_in: 0,
    }), async () => {
      const result = await beginRegistration(options())
      assert.equal(result.intervalSec, 5)
      assert.ok(result.expiresAt >= before + 599_000)
    })
  })

  await t.test('POS-25 successful Feishu approval returns created credentials', async () => {
    await withFetch(async () => jsonResponse({ client_id: 'cli_cn', client_secret: 'secret-cn', user_info: { open_id: 'ou_x' } }), async () => {
      assert.deepEqual(await pollRegistration(session()), {
        status: 'success', appId: 'cli_cn', appSecret: 'secret-cn', domain: 'feishu', openId: 'ou_x',
      })
    })
  })

  await t.test('POS-26 successful international approval reports the Lark domain', async () => {
    await withFetch(async () => jsonResponse({ client_id: 'cli_global', client_secret: 'secret-global' }), async () => {
      const result = await pollRegistration(session({ host: 'accounts.larksuite.com', switched: true }))
      assert.deepEqual(result, { status: 'success', appId: 'cli_global', appSecret: 'secret-global', domain: 'lark' })
    })
  })

  await t.test('POS-27 authorization_pending keeps the onboarding flow alive', async () => {
    await withFetch(async () => jsonResponse({ error: 'authorization_pending' }, 400), async () => {
      assert.deepEqual(await pollRegistration(session()), { status: 'pending' })
    })
  })

  await t.test('POS-28 slow_down increases the next polling delay', async () => {
    const active = session({ intervalSec: 5 })
    await withFetch(async () => jsonResponse({ error: 'slow_down' }, 400), async () => {
      assert.deepEqual(await pollRegistration(active), { status: 'pending' })
      assert.equal(active.intervalSec, 10)
    })
  })

  await t.test('POS-29 slow_down never exceeds the 30-second ceiling', async () => {
    const active = session({ intervalSec: 29 })
    await withFetch(async () => jsonResponse({ error: 'slow_down' }, 400), async () => {
      await pollRegistration(active)
      assert.equal(active.intervalSec, 30)
    })
  })

  await t.test('POS-30 Lark tenant detection switches the next poll to the international host', async () => {
    const active = session()
    await withFetch(async () => jsonResponse({ user_info: { tenant_brand: 'LARK' } }), async () => {
      assert.deepEqual(await pollRegistration(active), { status: 'pending' })
      assert.equal(active.host, 'accounts.larksuite.com')
      assert.equal(active.switched, true)
    })
  })

  await t.test('NEG-20 begin rejects a business error returned by Feishu', async () => {
    await withFetch(async () => jsonResponse({ error: 'invalid_request', error_description: 'unsupported archetype' }, 400), async () => {
      await assert.rejects(beginRegistration(options()), /invalid_request - unsupported archetype/)
    })
  })

  await t.test('NEG-21 begin rejects a response without device_code', async () => {
    await withFetch(async () => jsonResponse({ verification_uri_complete: 'https://accounts.feishu.cn/confirm' }), async () => {
      await assert.rejects(beginRegistration(options()), /missing device_code or confirm URL/)
    })
  })

  await t.test('NEG-22 begin rejects a response without a confirmation URL', async () => {
    await withFetch(async () => jsonResponse({ device_code: 'device' }), async () => {
      await assert.rejects(beginRegistration(options()), /missing device_code or confirm URL/)
    })
  })

  await t.test('NEG-23 empty HTTP responses are rejected with status context', async () => {
    await withFetch(async () => new Response('', { status: 502 }), async () => {
      await assert.rejects(beginRegistration(options()), /empty response \(HTTP 502\)/)
    })
  })

  await t.test('NEG-24 malformed JSON cannot be treated as a registration session', async () => {
    await withFetch(async () => new Response('{broken', { status: 200 }), async () => {
      await assert.rejects(beginRegistration(options()), /JSON/)
    })
  })

  await t.test('NEG-25 locally expired QR code is rejected before any network call', async () => {
    let called = false
    await withFetch(async () => { called = true; return jsonResponse({}) }, async () => {
      assert.deepEqual(await pollRegistration(session({ expiresAt: Date.now() - 1 })), {
        status: 'expired', message: 'QR code expired; start over',
      })
      assert.equal(called, false)
    })
  })

  await t.test('NEG-26 user cancellation returns an actionable denied result', async () => {
    await withFetch(async () => jsonResponse({ error: 'access_denied' }, 400), async () => {
      assert.deepEqual(await pollRegistration(session()), {
        status: 'denied', message: 'authorization was cancelled by the user',
      })
    })
  })

  await t.test('NEG-27 server-side expired token asks the user to start again', async () => {
    await withFetch(async () => jsonResponse({ error: 'expired_token' }, 400), async () => {
      assert.deepEqual(await pollRegistration(session()), {
        status: 'expired', message: 'QR code expired; start over',
      })
    })
  })

  await t.test('NEG-28 unknown server errors are surfaced instead of looping forever', async () => {
    await withFetch(async () => jsonResponse({ error: 'server_error', error_description: 'try later' }, 500), async () => {
      assert.deepEqual(await pollRegistration(session()), { status: 'error', message: 'server_error: try later' })
    })
  })

  await t.test('NEG-29 transient network failure stays pending for a later retry', async () => {
    await withFetch(async () => { throw new Error('ECONNRESET') }, async () => {
      assert.deepEqual(await pollRegistration(session()), { status: 'pending' })
    })
  })

  await t.test('NEG-30 caller cancellation is not swallowed as a transient retry', async () => {
    const controller = new AbortController()
    controller.abort()
    await withFetch(async () => { throw new Error('aborted') }, async () => {
      await assert.rejects(pollRegistration(session(), controller.signal), /aborted/)
    })
  })

  await t.test('NEG-31 partial credentials never produce a false success', async () => {
    await withFetch(async () => jsonResponse({ client_id: 'cli_only' }), async () => {
      assert.deepEqual(await pollRegistration(session()), { status: 'pending' })
    })
  })

  await t.test('POS-44 begin request uses the PersonalAgent registration contract', async () => {
    await withFetch(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      assert.equal(form.get('action'), 'begin')
      assert.equal(form.get('archetype'), 'PersonalAgent')
      assert.equal(form.get('auth_method'), 'client_secret')
      assert.equal(form.get('request_user_info'), 'open_id')
      return jsonResponse({ device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm' })
    }, async () => { await beginRegistration(options()) })
  })

  await t.test('POS-45 existing confirmation query parameters are preserved', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm?tenant=demo',
    }), async () => {
      const result = await beginRegistration(options())
      assert.equal(new URL(result.qrUrl).searchParams.get('tenant'), 'demo')
    })
  })

  await t.test('POS-46 mixed-case Lark tenant brand is detected', async () => {
    const active = session()
    await withFetch(async () => jsonResponse({ user_info: { tenant_brand: 'LaRk' } }), async () => {
      await pollRegistration(active)
      assert.equal(active.host, 'accounts.larksuite.com')
    })
  })

  await t.test('POS-47 an already international session remains on its current host', async () => {
    const active = session({ host: 'accounts.larksuite.com', switched: true })
    await withFetch(async () => jsonResponse({ user_info: { tenant_brand: 'lark' } }), async () => {
      assert.deepEqual(await pollRegistration(active), { status: 'pending' })
      assert.equal(active.host, 'accounts.larksuite.com')
      assert.equal(active.switched, true)
    })
  })

  await t.test('POS-48 an empty error field is treated as still pending', async () => {
    await withFetch(async () => jsonResponse({ error: '' }), async () => {
      assert.deepEqual(await pollRegistration(session()), { status: 'pending' })
    })
  })

  await t.test('POS-49 a Feishu tenant brand does not trigger an international switch', async () => {
    const active = session()
    await withFetch(async () => jsonResponse({ user_info: { tenant_brand: 'feishu' } }), async () => {
      await pollRegistration(active)
      assert.equal(active.host, 'accounts.feishu.cn')
      assert.equal(active.switched, false)
    })
  })

  await t.test('POS-50 caller AbortSignal is combined with the request timeout', async () => {
    const controller = new AbortController()
    await withFetch(async (_input, init) => {
      assert.ok(init?.signal)
      assert.equal(init.signal.aborted, false)
      return jsonResponse({ device_code: 'device', verification_uri_complete: 'https://accounts.feishu.cn/confirm' })
    }, async () => { await beginRegistration({ ...options(), signal: controller.signal }) })
  })

  await t.test('NEG-48 HTTP confirmation links are rejected', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'http://accounts.feishu.cn/confirm',
    }), async () => {
      await assert.rejects(beginRegistration(options()), /untrusted confirm URL/)
    })
  })

  await t.test('NEG-49 confirmation links on an unexpected host are rejected', async () => {
    await withFetch(async () => jsonResponse({
      device_code: 'device', verification_uri_complete: 'https://example.com/phishing',
    }), async () => {
      await assert.rejects(beginRegistration(options()), /untrusted confirm URL/)
    })
  })

  await t.test('NEG-50 begin-registration network failures propagate to the caller', async () => {
    await withFetch(async () => { throw new Error('DNS unavailable') }, async () => {
      await assert.rejects(beginRegistration(options()), /DNS unavailable/)
    })
  })
})
