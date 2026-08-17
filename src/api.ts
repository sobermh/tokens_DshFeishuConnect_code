/**
 * Minimal Feishu (Lark) OpenAPI client used by the plugin: token acquisition
 * plus the few endpoints the registered tools call. Every method throws on a
 * non-zero Feishu `code` so tool failures surface as `isError`.
 * @module
 */

/** Feishu OpenAPI envelope: `code === 0` is success. */
interface FeishuEnvelope<T> {
  code: number
  msg: string
  data?: T
}

/** One resolved way to authenticate a request. */
export interface FeishuAuth {
  /** `Bearer` token value (tenant or user access token). */
  token: string
  /** Which grant produced the token; only affects error messages. */
  kind: 'tenant' | 'user'
}

/** Options for one {@link feishuFetch} caller. */
export interface FeishuClientOptions {
  /** OpenAPI origin; self-hosted Lark suites override it. */
  baseURL: string
  /** Resolve the auth to use for the next request. */
  resolveAuth: () => Promise<FeishuAuth>
  /** Abort signal for in-flight requests. */
  signal?: AbortSignal
}

async function feishuFetch<T>(
  options: FeishuClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = await options.resolveAuth()
  const response = await fetch(new URL(path, options.baseURL), {
    method,
    headers: {
      'authorization': `Bearer ${auth.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  if (!response.ok) {
    throw new Error(`Feishu ${method} ${path} failed: HTTP ${response.status} (${auth.kind} token)`)
  }
  const envelope = await response.json() as FeishuEnvelope<T>
  if (envelope.code !== 0) {
    throw new Error(`Feishu ${method} ${path} failed: code ${envelope.code} ${envelope.msg} (${auth.kind} token)`)
  }
  return envelope.data as T
}

/**
 * Fetch a tenant access token from an internal app's id/secret.
 * @param baseURL - OpenAPI origin.
 * @param appId - internal app id.
 * @param appSecret - internal app secret.
 * @param signal - abort signal for the request.
 * @returns the tenant access token value.
 */
export async function fetchTenantToken(
  baseURL: string,
  appId: string,
  appSecret: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(new URL('/open-apis/auth/v3/tenant_access_token/internal', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`Feishu tenant token request failed: HTTP ${response.status}`)
  const payload = await response.json() as { code: number; msg: string; tenant_access_token?: string }
  if (payload.code !== 0 || payload.tenant_access_token === undefined) {
    throw new Error(`Feishu tenant token request failed: code ${payload.code} ${payload.msg}`)
  }
  return payload.tenant_access_token
}

/** One issued user-token grant, including the refresh credential when `offline_access` was granted. */
export interface UserTokenGrant {
  token: string
  refreshToken?: string
  expiresIn: number
}

async function postTokenGrant(
  baseURL: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<UserTokenGrant> {
  const response = await fetch(new URL('/open-apis/authen/v2/oauth/token', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    ...signal === undefined ? {} : { signal },
  })
  const payload = await response.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!response.ok || payload.access_token === undefined) {
    const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
    throw new Error(`Feishu user token grant failed: ${reason}`)
  }
  return {
    token: payload.access_token,
    ...payload.refresh_token === undefined ? {} : { refreshToken: payload.refresh_token },
    expiresIn: payload.expires_in ?? 0,
  }
}

/**
 * Exchange a personal OAuth authorization code for a user access token.
 * @param baseURL - OpenAPI origin.
 * @param appId - app id the code was issued for.
 * @param appSecret - matching app secret.
 * @param code - authorization code from the redirect.
 * @param redirectUri - redirect URI the authorize URL carried.
 * @param signal - abort signal for the request.
 * @returns the issued grant.
 */
export async function exchangeUserToken(
  baseURL: string,
  appId: string,
  appSecret: string,
  code: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<UserTokenGrant> {
  return postTokenGrant(baseURL, {
    grant_type: 'authorization_code',
    client_id: appId,
    client_secret: appSecret,
    code,
    redirect_uri: redirectUri,
  }, signal)
}

/**
 * Refresh a user access token with the stored refresh token.
 * @param baseURL - OpenAPI origin.
 * @param appId - app id the grant belongs to.
 * @param appSecret - matching app secret.
 * @param refreshToken - stored refresh token.
 * @param signal - abort signal for the request.
 * @returns the renewed grant (Feishu rotates the refresh token).
 */
export async function refreshUserToken(
  baseURL: string,
  appId: string,
  appSecret: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<UserTokenGrant> {
  return postTokenGrant(baseURL, {
    grant_type: 'refresh_token',
    client_id: appId,
    client_secret: appSecret,
    refresh_token: refreshToken,
  }, signal)
}

/**
 * Build the personal-authorization URL the user opens in a browser.
 * @param baseURL - OpenAPI origin.
 * @param appId - app id requesting authorization.
 * @param redirectUri - where Feishu sends the code.
 * @returns the authorize URL.
 */
export function buildAuthorizeUrl(baseURL: string, appId: string, redirectUri: string): string {
  const url = new URL('/open-apis/authen/v1/authorize', baseURL)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', 'dsh-feishu')
  return url.toString()
}

/**
 * Create an empty docx document.
 * @param options - client options.
 * @param title - document title.
 * @param folderToken - optional destination folder.
 * @returns document id, title, and canonical URL.
 */
export async function createDocument(
  options: FeishuClientOptions,
  title: string,
  folderToken?: string,
): Promise<{ documentId: string; title: string; url: string }> {
  const data = await feishuFetch<{ document: { document_id: string; title: string } }>(
    options,
    'POST',
    '/open-apis/docx/v1/documents',
    { title, ...folderToken === undefined ? {} : { folder_token: folderToken } },
  )
  const documentId = data.document.document_id
  const origin = new URL(options.baseURL).origin.replace('open.', '')
  return { documentId, title: data.document.title, url: `${origin}/docx/${documentId}` }
}

/**
 * Send a plain-text message to a user or chat.
 * @param options - client options.
 * @param receiveIdType - which id space `receiveId` belongs to.
 * @param receiveId - target user/chat id.
 * @param text - message body.
 * @returns the created message id.
 */
export async function sendTextMessage(
  options: FeishuClientOptions,
  receiveIdType: 'open_id' | 'user_id' | 'email' | 'chat_id',
  receiveId: string,
  text: string,
): Promise<{ messageId: string }> {
  const data = await feishuFetch<{ message_id: string }>(
    options,
    'POST',
    `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
  )
  return { messageId: data.message_id }
}
