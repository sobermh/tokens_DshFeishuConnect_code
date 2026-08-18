/**
 * Feishu (Lark) connectivity plugin with true one-click onboarding. The whole
 * connection is model- or human-driven and needs no developer-console visit:
 * `feishu_connect` starts the TokensAgent-style one-click app creation (the
 * user opens ONE link and confirms; the Feishu app is created with the full
 * scope grant pre-filled), then the plugin provisions the official Larksuite
 * CLI (latest release, checksum-verified, auto-updating) and drives its
 * built-in device-code login — the user opens a SECOND link, authorizes, and
 * lark-cli stores the personal user token in the OS keychain. The flow is
 * idempotent — an existing session is reused with no link, and a returning user
 * who only needs to re-authorize opens just that one link. No redirect URL, no
 * whitelist, no admin approval. On connect the plugin also materializes the
 * official lark-* skills (version-matched to the binary) so custom sibling
 * skills that depend on `lark-shared` just work — install-and-go, self-healing.
 * Domain tools (`feishu_create_doc`, `feishu_send_message`,
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
import { createLarkcli, type AuthStatus } from './larkcli.ts'
import { readIdentity, writeIdentity, type IdentityRecord } from './identity.ts'
import { ensureSkills } from './skills-provision.ts'

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

  // Materialize the official lark-* skills once the binary is present (i.e. on
  // a successful connect). Best-effort and deduped: it must never fail a
  // connection, and its own version stamp makes repeat calls cheap. Because a
  // missing `lark-shared/SKILL.md` forces re-materialization, this also self-
  // heals whenever a user deletes the managed skills.
  let skillsInFlight: Promise<unknown> | undefined
  function materializeSkillsInBackground(): void {
    if (skillsInFlight !== undefined) return
    skillsInFlight = ensureSkills()
      .then((result) => {
        if (!result.skipped) {
          ctx.logger.info('materialized %d lark skills (%s) into %s', result.count, result.version, result.root)
        }
      })
      .catch((error: unknown) => {
        ctx.logger.warn('lark skill materialization failed: %s', error instanceof Error ? error.message : String(error))
      })
      .finally(() => { skillsInFlight = undefined })
  }

  function setState(next: Partial<ConnectState> & { phase: ConnectPhase }): void {
    state.phase = next.phase
    state.qrUrl = next.qrUrl
    state.authorizeUrl = next.authorizeUrl
    state.message = next.message
    if (next.openId !== undefined) state.openId = next.openId
    if (next.phase === 'connected') materializeSkillsInBackground()
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

  /** Connected-state message, naming the user (falling back to cached identity). */
  async function connectedMessage(status: AuthStatus): Promise<string> {
    let name = status.userName
    if (name === undefined) name = (await readIdentity(config.profile))?.userName
    return name === undefined
      ? 'Feishu is connected with your personal identity.'
      : `Feishu is connected as ${name}.`
  }

  /**
   * Persist a non-secret record of who is connected. The user token is never
   * written here — lark-cli keeps that in the OS keychain and stays the source
   * of truth. Best-effort: a failed write must not fail the connection.
   */
  async function recordIdentity(status: AuthStatus): Promise<void> {
    const record: IdentityRecord = { profile: config.profile, connectedAt: new Date().toISOString() }
    if (status.userName !== undefined) record.userName = status.userName
    if (status.openId !== undefined) record.openId = status.openId
    await writeIdentity(record).catch(() => { /* metadata cache is best-effort */ })
  }

  /**
   * Re-bind the lark-cli profile from the app credentials already saved in the
   * DSH credential store. Used when the app is known (its id/secret are stored)
   * but the local lark-cli profile config was lost — e.g. `~/.lark-cli` was
   * wiped — so we reuse the existing app instead of minting a new one and
   * orphaning it. Returns `false` when the stored credentials are incomplete,
   * so the caller falls back to a full registration.
   */
  async function rebindStoredApp(signal: AbortSignal): Promise<boolean> {
    const id = await ctx.credentials.resolve(appIdRef)
    const secret = await ctx.credentials.resolve(appSecretRef)
    if (id === undefined || secret === undefined) return false
    await lark.provision()
    await lark.configInit(id.value, secret.value, signal)
    return true
  }

  /**
   * Authorize against an app whose lark-cli profile config already persists
   * (created in an earlier run), so the user only opens the single device-code
   * link. When `loginBegin` fails because the profile config is missing (e.g.
   * `~/.lark-cli` was wiped) the stored app credentials are used to re-bind the
   * profile and the login is retried — reusing the same app rather than minting
   * a new one. Returns `false` — without surfacing an error — only when the app
   * cannot be reused at all (no stored credentials to re-bind), so the caller
   * falls back to a full registration. A genuine authorization failure throws.
   */
  async function authorizeReusingApp(signal: AbortSignal): Promise<boolean> {
    await lark.provision()
    let begin
    try {
      begin = await lark.loginBegin(signal)
    } catch {
      // Profile config missing/corrupt: re-bind from stored creds, then retry.
      if (!(await rebindStoredApp(signal))) return false
      try {
        begin = await lark.loginBegin(signal)
      } catch {
        return false
      }
    }
    setState({
      phase: 'authorizing',
      authorizeUrl: begin.verificationUrl,
      message: 'Open this link and confirm to grant your personal Feishu identity.',
    })
    const status = await lark.loginComplete(begin.deviceCode, signal)
    await recordIdentity(status)
    setState({ phase: 'connected', message: await connectedMessage(status) })
    return true
  }

  /** Full one-click flow: register a brand-new app, bind it, then authorize. */
  async function registerAndAuthorize(domain: 'feishu' | 'lark', signal: AbortSignal): Promise<void> {
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
    await recordIdentity(status)
    setState({ phase: 'connected', message: await connectedMessage(status) })
  }

  /**
   * Drive the connection idempotently. Without `force`: an existing valid
   * connection is reused as-is (no link), an already-created app skips straight
   * to the single authorization link, and only a first-time connection shows
   * both links. With `force`: the current user session is dropped and personal
   * authorization is re-run (reusing the app) so a different identity can sign
   * in.
   */
  async function runConnectFlow(domain: 'feishu' | 'lark', force: boolean, signal: AbortSignal): Promise<void> {
    const current = await lark.status(signal).catch(() => undefined)
    if (!force && current?.connected === true) {
      await recordIdentity(current)
      setState({ phase: 'connected', message: await connectedMessage(current) })
      return
    }
    // Forced switch: drop the existing user session but keep the app.
    if (force && current !== undefined) await lark.logout(signal)

    // Reuse an already-created app when possible; only register when we must.
    const appConfigured = (await ctx.credentials.describe(appIdRef)).configured
    if (appConfigured && await authorizeReusingApp(signal)) return

    await registerAndAuthorize(domain, signal)
  }

  function startConnect(domain: 'feishu' | 'lark', force: boolean): void {
    flowAbort?.abort()
    const controller = new AbortController()
    flowAbort = controller
    setState({ phase: 'creating', message: 'Checking existing Feishu connection…' })
    runConnectFlow(domain, force, controller.signal).catch((error: unknown) => {
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

  /**
   * Merge live flow state with configured/authorized truth. After a restart the
   * in-memory phase is `idle` but lark-cli may still hold a valid session, so
   * normalize that to `connected` for an honest snapshot.
   */
  async function fullStatus() {
    const configured = await describeConfigured()
    const snapshot = statusSnapshot()
    const phase = snapshot.phase === 'idle' && configured.userAuthorized ? 'connected' as const : snapshot.phase
    return { ...snapshot, phase, ...configured }
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
      + 'opens in a browser — show it to the user, then follow the flow with feishu_status. Idempotent: if '
      + 'Feishu is already connected it returns connected with no link, and a returning user who only needs '
      + 'to re-authorize gets a single link (the existing app is reused). Pass force=true to re-authorize as '
      + 'a different account. Use when the user wants to connect Feishu or a Feishu tool reports missing '
      + 'credentials.',
    parameters: {
      domain: {
        type: 'string',
        enum: ['feishu', 'lark'],
        description: 'feishu = China (default), lark = international tenants',
      },
      force: {
        type: 'boolean',
        description: 'Re-run personal authorization even if already connected, to switch account '
          + '(reuses the existing app). Default false: reuse the current connection.',
      },
    },
    output: {
      schema: statusOutput,
      render: (_args, value) => renderStatus(value),
    },
    async execute(args) {
      startConnect(args.domain ?? 'feishu', args.force ?? false)
      // Wait until the flow leaves the initial check: a link appears, it
      // short-circuits to connected, or it fails.
      for (let i = 0; i < 100 && state.phase === 'creating' && state.qrUrl === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return await fullStatus()
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
      return await fullStatus()
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
      description: 'One-click Feishu connection: reuses an existing connection, or creates the app and starts '
        + 'personal device-code authorization. Add "force" to re-authorize as a different account.',
      input: { hint: '[lark] [force]' },
      async handler({ rawInput }) {
        const tokens = rawInput.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const domain = tokens.includes('lark') ? 'lark' : 'feishu'
        const force = tokens.includes('force')
        startConnect(domain, force)
        for (let i = 0; i < 100 && state.phase === 'creating' && state.qrUrl === undefined; i++) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        if (state.phase === 'error') {
          return { kind: 'error', text: state.message ?? 'Feishu connection failed' }
        }
        if (state.phase === 'connected') {
          return { kind: 'success', text: state.message ?? 'Feishu is already connected.' }
        }
        if (state.authorizeUrl !== undefined) {
          return {
            kind: 'success',
            text: `Open this link and confirm to grant personal authorization:\n${state.authorizeUrl}\n`
              + 'Then run /feishu-status to finish.',
          }
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
        const text = renderStatus(await fullStatus())
          .map((block) => block.text).join('\n')
        return { kind: 'success', text }
      },
    })

    commandCtx.commands.register({
      name: 'feishu-skills-refresh',
      description: 'Re-download the lark-cli binary if newer, then re-materialize the official lark-* skills '
        + '(version-matched). Normally automatic on connect; use this to force an update.',
      async handler() {
        try {
          const result = await ensureSkills(true)
          return {
            kind: 'success',
            text: `Materialized ${result.count} lark skills (${result.version}) into ${result.root}.`,
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  })
}
