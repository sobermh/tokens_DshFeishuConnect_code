/**
 * Feishu (Lark) connectivity plugin with one-click onboarding. The model
 * drives the whole connection: `feishu_connect` starts the TokensAgent-style
 * one-click app creation (the user opens ONE link, confirms, and the Feishu
 * app is created with the full scope grant pre-filled), the plugin then
 * auto-configures the OAuth redirect, catches the personal-authorization
 * callback on localhost, and stores every credential. `feishu_status`
 * long-polls the flow so the agent can walk the user through it. Domain
 * tools (`feishu_create_doc`, `feishu_send_message`) authenticate with the
 * personal user token (auto-refreshed) or fall back to the tenant token.
 * `/feishu-connect` and `/feishu-status` expose the same flow to humans.
 * @module @tokens/feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildAuthorizeUrl,
  createDocument,
  exchangeUserToken,
  fetchTenantToken,
  refreshUserToken,
  sendTextMessage,
} from './api.ts'
import type { FeishuAuth, FeishuClientOptions } from './api.ts'
import { startCallbackServer } from './oauth-server.ts'
import { beginRegistration, configureOAuthRedirect, pollRegistration } from './register.ts'
import { TENANT_SCOPES, USER_SCOPES } from './scopes.ts'

export const name = 'feishu'
export const inject = ['tools', 'credentials']

/** Plugin config: credential references and endpoints, never secret values. */
export interface Config {
  /** Credential reference for the Feishu app id. */
  appIdEnv: string
  /** Credential reference for the Feishu app secret. */
  appSecretEnv: string
  /** Credential reference for the personal user access token. */
  userTokenEnv: string
  /** Credential reference for the personal refresh token. */
  refreshTokenEnv: string
  /** Credential reference recording the user token's expiry (epoch ms). */
  tokenExpiresEnv: string
  /** OpenAPI origin; `https://open.larksuite.com` for international tenants. */
  baseURL: string
  /** Localhost port that catches the personal-authorization redirect. */
  oauthPort: number
  /** App name preset onto the one-click creation confirm page. */
  appName: string
  /** App description preset onto the one-click creation confirm page. */
  appDesc: string
}

export const Config: Schema<Config> = Schema.object({
  appIdEnv: Schema.string().role('credential-ref').default('FEISHU_APP_ID'),
  appSecretEnv: Schema.string().role('credential-ref').default('FEISHU_APP_SECRET'),
  userTokenEnv: Schema.string().role('credential-ref').default('FEISHU_USER_TOKEN'),
  refreshTokenEnv: Schema.string().role('credential-ref').default('FEISHU_REFRESH_TOKEN'),
  tokenExpiresEnv: Schema.string().role('credential-ref').default('FEISHU_TOKEN_EXPIRES_AT'),
  baseURL: Schema.string().default('https://open.feishu.cn'),
  oauthPort: Schema.number().step(1).min(1).max(65535).default(3000),
  appName: Schema.string().default('TokensAgent'),
  appDesc: Schema.string().default('DeepSeek Harness · Feishu connector'),
})

/** Connection-flow phase visible to the agent and the user. */
type ConnectPhase = 'idle' | 'creating' | 'authorizing' | 'connected' | 'error'

interface ConnectState {
  phase: ConnectPhase
  /** One-click creation confirm link (phase `creating`). */
  qrUrl?: string | undefined
  /** Personal-authorization link (phase `authorizing`). */
  authorizeUrl?: string | undefined
  /** User-facing progress or error message. */
  message?: string | undefined
  /** Open id of the confirming user, when Feishu reports it. */
  openId?: string | undefined
}

export function apply(ctx: Context, config: Config) {
  const appIdRef = credentialRef(config.appIdEnv)
  const appSecretRef = credentialRef(config.appSecretEnv)
  const userTokenRef = credentialRef(config.userTokenEnv)
  const refreshTokenRef = credentialRef(config.refreshTokenEnv)
  const tokenExpiresRef = credentialRef(config.tokenExpiresEnv)
  const redirectUri = `http://localhost:${config.oauthPort}/callback`

  // ---- connection-flow state machine (one flow at a time) -----------------

  const state: ConnectState = { phase: 'idle' }
  let flowAbort: AbortController | undefined
  let closeServer: (() => void) | undefined
  const phaseWaiters = new Set<() => void>()

  function setState(next: Partial<ConnectState> & { phase: ConnectPhase }): void {
    state.phase = next.phase
    state.qrUrl = next.qrUrl
    state.authorizeUrl = next.authorizeUrl
    state.message = next.message
    if (next.openId !== undefined) state.openId = next.openId
    for (const wake of phaseWaiters) wake()
    phaseWaiters.clear()
  }

  // Plugin disposal cancels any in-flight flow and frees the callback port.
  ctx.effect(() => () => {
    flowAbort?.abort()
    closeServer?.()
  })

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { resolve() }, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('Feishu connection flow cancelled'))
      }, { once: true })
    })
  }

  async function runConnectFlow(domain: 'feishu' | 'lark', signal: AbortSignal): Promise<void> {
    const session = await beginRegistration({
      domain,
      appName: config.appName,
      appDesc: config.appDesc,
      tenantScopes: TENANT_SCOPES,
      userScopes: USER_SCOPES,
      signal,
    })
    setState({
      phase: 'creating',
      qrUrl: session.qrUrl,
      message: 'Waiting for the user to open the link and confirm app creation.',
    })

    // Poll until the created app's credentials arrive.
    let appId: string, appSecret: string
    for (;;) {
      await sleep(session.intervalSec * 1000, signal)
      const outcome = await pollRegistration(session, signal)
      if (outcome.status === 'pending') continue
      if (outcome.status !== 'success') {
        setState({ phase: 'error', message: outcome.message })
        return
      }
      appId = outcome.appId
      appSecret = outcome.appSecret
      setState({
        phase: 'creating',
        qrUrl: session.qrUrl,
        message: 'App created; configuring authorization…',
        ...outcome.openId === undefined ? {} : { openId: outcome.openId },
      })
      break
    }

    await ctx.credentials.set(appIdRef, appId)
    await ctx.credentials.set(appSecretRef, appSecret)

    // Programmatically add the localhost callback so personal OAuth works
    // without a developer-console visit (needs application:application:patch).
    const tenantToken = await fetchTenantToken(config.baseURL, appId, appSecret, signal)
    await configureOAuthRedirect(config.baseURL, tenantToken, appId, redirectUri, signal)

    // Catch the single personal-authorization redirect on localhost.
    const server = await startCallbackServer(config.oauthPort)
    closeServer = server.close
    signal.addEventListener('abort', server.close, { once: true })
    setState({
      phase: 'authorizing',
      authorizeUrl: buildAuthorizeUrl(config.baseURL, appId, redirectUri),
      message: 'App created. Waiting for the user to open the authorization link.',
    })

    try {
      const code = await server.code
      const grant = await exchangeUserToken(config.baseURL, appId, appSecret, code, redirectUri, signal)
      await storeGrant(grant.token, grant.refreshToken, grant.expiresIn)
      setState({ phase: 'connected', message: 'Feishu is connected with your personal identity.' })
    } finally {
      closeServer = undefined
    }
  }

  async function storeGrant(token: string, refreshToken: string | undefined, expiresIn: number): Promise<void> {
    await ctx.credentials.set(userTokenRef, token)
    if (refreshToken !== undefined) await ctx.credentials.set(refreshTokenRef, refreshToken)
    await ctx.credentials.set(tokenExpiresRef, String(Date.now() + expiresIn * 1000))
  }

  function startConnect(domain: 'feishu' | 'lark'): void {
    flowAbort?.abort()
    closeServer?.()
    const controller = new AbortController()
    flowAbort = controller
    setState({ phase: 'creating', message: 'Starting one-click app creation…' })
    runConnectFlow(domain, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  function statusSnapshot() {
    return {
      phase: state.phase,
      qrUrl: state.qrUrl ?? null,
      authorizeUrl: state.authorizeUrl ?? null,
      message: state.message ?? null,
    }
  }

  async function describeConfigured(): Promise<{ appConfigured: boolean; userAuthorized: boolean }> {
    const app = await ctx.credentials.describe(appIdRef)
    const user = await ctx.credentials.describe(userTokenRef)
    return { appConfigured: app.configured, userAuthorized: user.configured }
  }

  // ---- request authentication --------------------------------------------

  // Tenant tokens live ~2h; cache one in memory. The personal token is
  // provider-stored and re-resolved per request, refreshed ahead of expiry.
  let tenantCache: { token: string; expiresAt: number } | undefined

  async function resolveAppSecrets(): Promise<{ appId: string; appSecret: string }> {
    const appId = (await ctx.credentials.resolve(appIdRef))?.value
    const appSecret = (await ctx.credentials.resolve(appSecretRef))?.value
    if (appId === undefined || appSecret === undefined) {
      throw new Error(
        'Feishu is not connected yet. Call the feishu_connect tool (or run /feishu-connect) '
        + 'to create and authorize a Feishu app in one click.',
      )
    }
    return { appId, appSecret }
  }

  async function resolveUserToken(): Promise<string | undefined> {
    const token = (await ctx.credentials.resolve(userTokenRef))?.value
    if (token === undefined) return undefined
    const expiresAtRaw = (await ctx.credentials.resolve(tokenExpiresRef))?.value
    const expiresAt = expiresAtRaw === undefined ? undefined : Number(expiresAtRaw)
    const stillValid = expiresAt === undefined || Number.isNaN(expiresAt)
      || Date.now() < expiresAt - 5 * 60 * 1000
    if (stillValid) return token

    const refreshToken = (await ctx.credentials.resolve(refreshTokenRef))?.value
    if (refreshToken === undefined) return undefined
    const { appId, appSecret } = await resolveAppSecrets()
    const grant = await refreshUserToken(config.baseURL, appId, appSecret, refreshToken)
    await storeGrant(grant.token, grant.refreshToken, grant.expiresIn)
    return grant.token
  }

  async function resolveAuth(): Promise<FeishuAuth> {
    const user = await resolveUserToken()
    if (user !== undefined) return { token: user, kind: 'user' }
    if (tenantCache !== undefined && tenantCache.expiresAt > Date.now()) {
      return { token: tenantCache.token, kind: 'tenant' }
    }
    const { appId, appSecret } = await resolveAppSecrets()
    const token = await fetchTenantToken(config.baseURL, appId, appSecret)
    tenantCache = { token, expiresAt: Date.now() + 90 * 60 * 1000 }
    return { token, kind: 'tenant' }
  }

  function clientOptions(signal: AbortSignal): FeishuClientOptions {
    return { baseURL: config.baseURL, resolveAuth, signal }
  }

  // ---- connection tools (the model drives the onboarding) ----------------

  const statusOutput = {
    type: 'object',
    properties: {
      phase: { type: 'string', required: true, enum: ['idle', 'creating', 'authorizing', 'connected', 'error'] },
      qrUrl: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      authorizeUrl: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      message: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      appConfigured: { type: 'boolean', required: true },
      userAuthorized: { type: 'boolean', required: true },
    },
    additionalProperties: false,
  } as const

  function renderStatus(value: {
    phase: string
    qrUrl: string | null
    authorizeUrl: string | null
    message: string | null
    appConfigured: boolean
    userAuthorized: boolean
  }): { type: 'text'; text: string }[] {
    const lines = [`Feishu connection phase: ${value.phase}`]
    if (value.qrUrl !== null && value.phase === 'creating') {
      lines.push(`Ask the user to open this link to create the app in one click: ${value.qrUrl}`)
    }
    if (value.authorizeUrl !== null && value.phase === 'authorizing') {
      lines.push(`Ask the user to open this link to grant personal authorization: ${value.authorizeUrl}`)
    }
    if (value.message !== null) lines.push(value.message)
    lines.push(`app configured: ${value.appConfigured}, personal identity authorized: ${value.userAuthorized}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  ctx.tools.register(defineTool({
    name: 'feishu_connect',
    description: 'Connect Feishu (Lark) with one-click onboarding: creates a Feishu app with all needed '
      + 'permissions pre-granted and starts personal authorization. Returns a link the user opens in a '
      + 'browser — show it to the user, then follow the flow with feishu_status. Use when the user wants '
      + 'to connect Feishu or a Feishu tool reports missing credentials.',
    parameters: {
      domain: {
        type: 'string',
        enum: ['feishu', 'lark'],
        description: 'feishu = China (default), lark = international tenants',
      },
    },
    output: {
      schema: statusOutput,
      render: (_args, value) => renderStatus(value),
    },
    async execute(args) {
      startConnect(args.domain ?? 'feishu')
      // Wait for the begin call to produce the confirm link (or fail fast).
      for (let i = 0; i < 100 && state.phase === 'creating' && state.qrUrl === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return { ...statusSnapshot(), ...await describeConfigured() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'feishu_status',
    description: 'Check the Feishu connection flow. Long-polls: waits up to wait_seconds for the phase to '
      + 'change before returning. Call this after feishu_connect until phase is connected (relay each new '
      + 'link to the user) or error.',
    parameters: {
      wait_seconds: { type: 'integer', description: 'Max seconds to wait for a phase change (default 20)' },
    },
    output: {
      schema: statusOutput,
      render: (_args, value) => renderStatus(value),
    },
    async execute(args, exec) {
      const waitMs = Math.min(Math.max(args.wait_seconds ?? 20, 0), 120) * 1000
      const before = state.phase
      if (waitMs > 0 && (before === 'creating' || before === 'authorizing')) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { phaseWaiters.delete(wake); resolve() }, waitMs)
          const wake = () => { clearTimeout(timer); resolve() }
          phaseWaiters.add(wake)
          exec.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            phaseWaiters.delete(wake)
            resolve()
          }, { once: true })
        })
      }
      return { ...statusSnapshot(), ...await describeConfigured() }
    },
  }))

  // ---- domain tools -------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'feishu_create_doc',
    description: 'Create a new (empty) Feishu docx document and return its id and URL. '
      + 'If Feishu is not connected yet, use feishu_connect first.',
    parameters: {
      title: { type: 'string', required: true, description: 'Document title' },
      folder_token: { type: 'string', description: 'Destination folder token; omit for the root folder' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Created Feishu doc "${value.title}": ${value.url}` }],
    },
    async execute(args, exec) {
      return createDocument(clientOptions(exec.signal), args.title, args.folder_token)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'feishu_send_message',
    description: 'Send a plain-text Feishu message to a user or group chat. '
      + 'If Feishu is not connected yet, use feishu_connect first.',
    parameters: {
      receive_id_type: {
        type: 'string',
        required: true,
        enum: ['open_id', 'user_id', 'email', 'chat_id'],
        description: 'Which id space receive_id belongs to',
      },
      receive_id: { type: 'string', required: true, description: 'Target user or chat id' },
      text: { type: 'string', required: true, description: 'Message body' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { messageId: { type: 'string', required: true } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Sent Feishu message ${value.messageId}` }],
    },
    async execute(args, exec) {
      return sendTextMessage(clientOptions(exec.signal), args.receive_id_type, args.receive_id, args.text)
    },
  }))

  // ---- human commands (same flow without going through the model) --------

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'feishu-connect',
      description: 'One-click Feishu connection: creates the app and starts personal authorization.',
      input: { hint: '[lark]' },
      async handler({ rawInput }) {
        const domain = rawInput.trim().toLowerCase() === 'lark' ? 'lark' : 'feishu'
        startConnect(domain)
        for (let i = 0; i < 100 && state.phase === 'creating' && state.qrUrl === undefined; i++) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        if (state.phase === 'error') {
          return { kind: 'error', text: state.message ?? 'Feishu connection failed' }
        }
        return {
          kind: 'success',
          text: `Open this link to create and authorize the Feishu app in one click:\n${state.qrUrl ?? '(pending…)'}\n`
            + 'Then run /feishu-status to follow the flow (a second link completes personal authorization).',
        }
      },
    })

    commandCtx.commands.register({
      name: 'feishu-status',
      description: 'Show Feishu connection progress and any link waiting for you.',
      async handler() {
        const configured = await describeConfigured()
        const snapshot = statusSnapshot()
        const text = renderStatus({ ...snapshot, ...configured })
          .map((block) => block.text).join('\n')
        return { kind: 'success', text }
      },
    })
  })
}
