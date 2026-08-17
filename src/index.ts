/**
 * Feishu (Lark) connectivity plugin with true one-click onboarding. The whole
 * connection is model- or human-driven and needs no developer-console visit:
 * `feishu_connect` starts the TokensAgent-style one-click app creation (the
 * user opens ONE link and confirms; the Feishu app is created with the full
 * scope grant pre-filled), then the plugin provisions the official Larksuite
 * CLI (pinned, SHA-256-verified) and drives its built-in device-code login —
 * the user opens a SECOND link, authorizes, and lark-cli stores the personal
 * user token in the OS keychain. No redirect URL, no whitelist, no admin
 * approval. Domain tools (`feishu_create_doc`, `feishu_send_message`,
 * `feishu_create_bitable`) then act as that personal identity through the
 * generic `lark-cli api` passthrough. `/feishu-connect` and `/feishu-status`
 * expose the same flow to humans.
 * @module @tokens/feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { beginRegistration, pollRegistration } from './register.ts'
import { TENANT_SCOPES, USER_SCOPES } from './scopes.ts'
import { createLarkcli } from './larkcli.ts'

export const name = 'feishu'
export const inject = ['tools', 'credentials']

/** Plugin config: credential references and endpoints, never secret values. */
export interface Config {
  /** Credential reference for the created Feishu app id. */
  appIdEnv: string
  /** Credential reference for the created Feishu app secret. */
  appSecretEnv: string
  /** OpenAPI origin; `https://open.larksuite.com` for international tenants. */
  baseURL: string
  /** App name preset onto the one-click creation confirm page. */
  appName: string
  /** App description preset onto the one-click creation confirm page. */
  appDesc: string
  /** lark-cli profile the app credentials and user session live under. */
  profile: string
}

export const Config: Schema<Config> = Schema.object({
  appIdEnv: Schema.string().role('credential-ref').default('FEISHU_APP_ID'),
  appSecretEnv: Schema.string().role('credential-ref').default('FEISHU_APP_SECRET'),
  baseURL: Schema.string().default('https://open.feishu.cn'),
  appName: Schema.string().default('TokensAgent'),
  appDesc: Schema.string().default('DeepSeek Harness · Feishu connector'),
  profile: Schema.string().default('dsh-feishu'),
})

/** Connection-flow phase visible to the agent and the user. */
type ConnectPhase = 'idle' | 'creating' | 'authorizing' | 'connected' | 'error'

interface ConnectState {
  phase: ConnectPhase
  /** One-click creation confirm link (phase `creating`). */
  qrUrl?: string | undefined
  /** Device-code authorization link (phase `authorizing`). */
  authorizeUrl?: string | undefined
  /** User-facing progress or error message. */
  message?: string | undefined
  /** Open id of the confirming user, when Feishu reports it. */
  openId?: string | undefined
}

export function apply(ctx: Context, config: Config) {
  const appIdRef = credentialRef(config.appIdEnv)
  const appSecretRef = credentialRef(config.appSecretEnv)
  const lark = createLarkcli({ profile: config.profile, baseURL: config.baseURL })

  // ---- connection-flow state machine (one flow at a time) -----------------

  const state: ConnectState = { phase: 'idle' }
  let flowAbort: AbortController | undefined
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

  // Plugin disposal cancels any in-flight flow.
  ctx.effect(() => () => { flowAbort?.abort() })

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
        message: 'App created; preparing the local authorization tool…',
        ...outcome.openId === undefined ? {} : { openId: outcome.openId },
      })
      break
    }

    await ctx.credentials.set(appIdRef, appId)
    await ctx.credentials.set(appSecretRef, appSecret)

    // Provision the pinned lark-cli binary (first run downloads ~12 MB) and
    // bind the created app's credentials to the profile.
    await lark.provision()
    await lark.configInit(appId, appSecret, signal)

    // Drive lark-cli's built-in device-code login: it returns the second link
    // for the user to open, then blocks until they authorize in the browser.
    const begin = await lark.loginBegin(signal)
    setState({
      phase: 'authorizing',
      authorizeUrl: begin.verificationUrl,
      message: 'App created. Open this link and confirm to grant your personal Feishu identity.',
    })
    const status = await lark.loginComplete(begin.deviceCode, signal)
    setState({
      phase: 'connected',
      message: status.userName === undefined
        ? 'Feishu is connected with your personal identity.'
        : `Feishu is connected as ${status.userName}.`,
    })
  }

  function startConnect(domain: 'feishu' | 'lark'): void {
    flowAbort?.abort()
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
    let userAuthorized = false
    try {
      const status = await lark.status()
      userAuthorized = status?.connected ?? false
    } catch { /* lark-cli not ready yet → not authorized */ }
    return { appConfigured: app.configured, userAuthorized }
  }

  /** Fail domain tools early with an actionable message when not connected. */
  async function assertConnected(signal: AbortSignal): Promise<void> {
    let status
    try {
      status = await lark.status(signal)
    } catch {
      status = undefined
    }
    if (status?.connected !== true) {
      throw new Error(
        'Feishu is not connected yet. Call the feishu_connect tool (or run /feishu-connect) '
        + 'to create and authorize a Feishu app in one click.',
      )
    }
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
      lines.push(`Ask the user to open this link and confirm to grant personal authorization: ${value.authorizeUrl}`)
    }
    if (value.message !== null) lines.push(value.message)
    lines.push(`app configured: ${value.appConfigured}, personal identity authorized: ${value.userAuthorized}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  ctx.tools.register(defineTool({
    name: 'feishu_connect',
    description: 'Connect Feishu (Lark) with one-click onboarding: creates a Feishu app with all needed '
      + 'permissions pre-granted and starts personal (device-code) authorization. Returns a link the user '
      + 'opens in a browser — show it to the user, then follow the flow with feishu_status. Use when the '
      + 'user wants to connect Feishu or a Feishu tool reports missing credentials.',
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

  // ---- domain tools (act as the personal identity via `lark-cli api`) -----

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
      await assertConnected(exec.signal)
      const data = await lark.api<{ document: { document_id: string; title: string } }>(
        'POST',
        '/open-apis/docx/v1/documents',
        { as: 'user', data: { title: args.title, ...args.folder_token === undefined ? {} : { folder_token: args.folder_token } } },
        exec.signal,
      )
      const documentId = data.document.document_id
      const origin = new URL(config.baseURL).origin.replace('open.', '')
      return { documentId, title: data.document.title, url: `${origin}/docx/${documentId}` }
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
      await assertConnected(exec.signal)
      const data = await lark.api<{ message_id: string }>(
        'POST',
        '/open-apis/im/v1/messages',
        {
          as: 'user',
          params: { receive_id_type: args.receive_id_type },
          data: { receive_id: args.receive_id, msg_type: 'text', content: JSON.stringify({ text: args.text }) },
        },
        exec.signal,
      )
      return { messageId: data.message_id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'feishu_create_bitable',
    description: 'Create a new Feishu Base (多维表格 / Bitable) app and return its token and URL. '
      + 'If Feishu is not connected yet, use feishu_connect first.',
    parameters: {
      name: { type: 'string', required: true, description: 'Base name' },
      folder_token: { type: 'string', description: 'Destination folder token; omit for the root folder' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          appToken: { type: 'string', required: true },
          name: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Created Feishu Base "${value.name}": ${value.url}` }],
    },
    async execute(args, exec) {
      await assertConnected(exec.signal)
      const data = await lark.api<{ app: { app_token: string; name?: string; url?: string; folder_token?: string } }>(
        'POST',
        '/open-apis/bitable/v1/apps',
        { as: 'user', data: { name: args.name, ...args.folder_token === undefined ? {} : { folder_token: args.folder_token } } },
        exec.signal,
      )
      const origin = new URL(config.baseURL).origin.replace('open.', '')
      return {
        appToken: data.app.app_token,
        name: data.app.name ?? args.name,
        url: data.app.url ?? `${origin}/base/${data.app.app_token}`,
      }
    },
  }))

  // ---- human commands (same flow without going through the model) --------

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'feishu-connect',
      description: 'One-click Feishu connection: creates the app and starts personal device-code authorization.',
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
          text: `Open this link to create the Feishu app in one click:\n${state.qrUrl ?? '(pending…)'}\n`
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
