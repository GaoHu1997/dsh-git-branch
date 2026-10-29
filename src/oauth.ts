/**
 * GitHub OAuth device flow behind the credential dialog's site sign-in.
 *
 * A browser sign-in must never need a client SECRET (that would have to ship
 * in the bundle) and must work from a machine that cannot accept inbound
 * connections, so the plugin uses the OAuth 2.0 device authorization grant:
 * the host asks GitHub for a one-time user code, the dialog opens the browser
 * and shows that code, and the plugin polls the token endpoint until the user
 * approves. The token that comes back is stored like a pasted personal access
 * token (method `token`) and the user never sees a raw PAT workflow.
 *
 * Only hosts whose device flow this module knows are accepted; the caller
 * decides which of them to offer in the UI.
 *
 * @module git-worktree/oauth
 */

import { BROWSER_SIGN_IN_HOSTS } from './wire.js'

/** The hosts whose device flow this module implements. The dialog imports the
 * same list, so the offered buttons cannot drift from what the host supports. */
export const DEVICE_FLOW_HOSTS: readonly string[] = BROWSER_SIGN_IN_HOSTS

/**
 * Fallback OAuth App client id. GitHub's device flow requires a client id but
 * never a client secret; the shipped value is the public GitHub CLI app,
 * which lets a stock `gh` install and this plugin sign in with the same app.
 * Point `DSH_GITHUB_OAUTH_CLIENT_ID` at a dedicated OAuth App to use one.
 */
export const DEFAULT_OAUTH_CLIENT_ID = '178c6fc778ccc68e1d6a'

/** Scopes one push needs: `repo` covers private repositories and write access. */
export const OAUTH_SCOPE = 'repo'

/** One device-code grant, reduced to what the browser needs to show/open. */
export interface DeviceCodeGrant {
  /** Polling credential; never rendered. */
  deviceCode: string
  /** The short code the user types on the verification page. */
  userCode: string
  /** Verification page (without the code). */
  verificationUri: string
  /** Verification page with the code pre-filled, when GitHub returns one. */
  verificationUriComplete?: string
  /** Minimum seconds between polls. */
  intervalSeconds: number
  /** Seconds until the grant expires. */
  expiresInSeconds: number
}

/** One poll answer: the finished token, or why there is no token yet. */
export type DeviceFlowPoll =
  | { status: 'token'; token: string }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied'; message: string }
  | { status: 'expired'; message: string }
  | { status: 'failed'; message: string }

/**
 * The OAuth App client id to use: the environment override when set, else the
 * shipped default.
 * @param env - environment seam (`process.env` in production).
 */
export function deviceFlowClientId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.DSH_GITHUB_OAUTH_CLIENT_ID?.trim()
  return configured === undefined || configured === '' ? DEFAULT_OAUTH_CLIENT_ID : configured
}

/** Whether browser sign-in is implemented for this (normalized) host. */
export function isDeviceFlowHost(host: string): boolean {
  return DEVICE_FLOW_HOSTS.includes(host)
}

/** Read one non-empty string field from a parsed JSON object. */
function readString(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * POST one form-encoded body and parse the JSON answer. Network failures and
 * unexpected non-2xx answers become one thrown Error; callers map it to a
 * route failure. `allowErrorStatus` keeps the body of a documented OAuth
 * error answer (the token endpoint reports a pending grant as `400`), which
 * is an answer, not a transport failure.
 */
async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Readonly<Record<string, string>>,
  timeoutMs: number,
  allowErrorStatus = false,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`${url} could not be reached (${error instanceof Error ? error.message : String(error)})`)
  }
  let payload: unknown
  let parsed = false
  try {
    payload = await response.json()
    parsed = true
  } catch {
    parsed = false
  }
  if (!parsed) throw new Error(`${url} answered a non-JSON body`)
  if (!response.ok && !allowErrorStatus) throw new Error(`${url} answered HTTP ${String(response.status)}`)
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${url} answered an unexpected body`)
  }
  return payload as Record<string, unknown>
}

/**
 * Ask GitHub for a device code. The caller opens `verificationUriComplete`
 * (or `verificationUri` plus the shown `userCode`) and then polls.
 * @param fetchImpl - fetch seam (global fetch in production, a fake in tests).
 * @param host - normalized host; must be a {@link DEVICE_FLOW_HOSTS} member.
 * @param clientId - OAuth App client id, see {@link deviceFlowClientId}.
 * @param timeoutMs - per-request budget for the device-code request.
 */
export async function startDeviceFlow(
  fetchImpl: typeof fetch,
  host: string,
  clientId: string,
  timeoutMs = 15_000,
): Promise<DeviceCodeGrant> {
  const payload = await postForm(
    fetchImpl,
    `https://${host}/login/device/code`,
    { client_id: clientId, scope: OAUTH_SCOPE },
    timeoutMs,
  )
  const deviceCode = readString(payload, 'device_code')
  const userCode = readString(payload, 'user_code')
  const verificationUri = readString(payload, 'verification_uri')
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new Error(`${host} did not return a device code (is device flow enabled for the OAuth app?)`)
  }
  const interval = typeof payload.interval === 'number' && payload.interval > 0 ? payload.interval : 5
  const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 900
  const verificationUriComplete = readString(payload, 'verification_uri_complete')
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    intervalSeconds: interval,
    expiresInSeconds: expiresIn,
  }
}

/**
 * Poll the token endpoint once for one grant. GitHub answers `400` with an
 * `error` code until the user acts, so a pending grant is a normal answer,
 * not a thrown failure; only transport problems throw.
 * @param fetchImpl - fetch seam.
 * @param host - normalized host.
 * @param clientId - the same client id the grant was started with.
 * @param deviceCode - the grant's `deviceCode`.
 * @param timeoutMs - per-request budget for this poll.
 */
export async function pollDeviceFlow(
  fetchImpl: typeof fetch,
  host: string,
  clientId: string,
  deviceCode: string,
  timeoutMs = 15_000,
): Promise<DeviceFlowPoll> {
  const payload = await postForm(
    fetchImpl,
    `https://${host}/login/oauth/access_token`,
    {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    timeoutMs,
    // A pending grant is a 400 with an OAuth error body, not a failure.
    true,
  )
  const token = readString(payload, 'access_token')
  if (token !== undefined) return { status: 'token', token }
  const code = readString(payload, 'error') ?? 'unknown_error'
  const description = readString(payload, 'error_description') ?? code
  switch (code) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down' }
    case 'expired_token':
      return { status: 'expired', message: description }
    case 'access_denied':
      return { status: 'denied', message: description }
    default:
      return { status: 'failed', message: description }
  }
}
