/**
 * Browser sign-in tests: the GitHub device-flow client (src/oauth.ts) and the
 * two routes that drive it (handleCredentialsOAuthStart / …Poll).
 *
 * The device flow is the one credential path that talks to the network, so
 * every answer shape GitHub is documented to return gets a case here — a
 * pending grant must look pending, not like a failure, and an approved grant
 * must land in the store exactly once, as a `token` credential.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OAUTH_CLIENT_ID,
  DEVICE_FLOW_HOSTS,
  deviceFlowClientId,
  isDeviceFlowHost,
  pollDeviceFlow,
  startDeviceFlow,
} from '../src/oauth.ts'
import {
  handleCredentialsOAuthPoll,
  handleCredentialsOAuthStart,
  type RouteDeps,
} from '../src/routes.ts'
import type { CredentialStore, GitCredential } from '../src/credentials.ts'

/** One recorded fetch call. */
interface FetchCall {
  url: string
  method: string | undefined
  body: string
  headers: Record<string, string>
}

/** A fetch stand-in answering one canned JSON body, recording every call. */
function jsonFetch(payload: unknown, status = 200): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const raw = init?.headers
    if (raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, string>)) headers[key.toLowerCase()] = value
    }
    calls.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : '',
      headers,
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A fetch stand-in that fails the way a dead connection does. */
function brokenFetch(message = 'fetch failed'): typeof fetch {
  return (async () => {
    throw new TypeError(message)
  }) as unknown as typeof fetch
}

/** The device-code answer GitHub documents for a healthy grant. */
const GRANT = {
  device_code: 'dev-code-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
  expires_in: 900,
  interval: 5,
}

/** A token answer for an approved grant. */
const APPROVED = { access_token: 'gho_token', token_type: 'bearer', scope: 'repo' }

describe('startDeviceFlow', () => {
  it('asks the device-code endpoint and returns the grant', async () => {
    const { fetchImpl, calls } = jsonFetch(GRANT)
    const grant = await startDeviceFlow(fetchImpl, 'github.com', 'client-1')
    expect(grant).toEqual({
      deviceCode: 'dev-code-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-1234',
      intervalSeconds: 5,
      expiresInSeconds: 900,
    })
    // One form-encoded POST; the secret-free public-client shape.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://github.com/login/device/code')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0]?.headers.accept).toBe('application/json')
    const form = new URLSearchParams(calls[0]?.body ?? '')
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('scope')).toBe('repo')
  })

  it('defaults the interval and expiry when GitHub omits them', async () => {
    const { fetchImpl } = jsonFetch({ device_code: 'd', user_code: 'U', verification_uri: 'https://x' })
    const grant = await startDeviceFlow(fetchImpl, 'github.com', 'client-1')
    expect(grant.intervalSeconds).toBe(5)
    expect(grant.expiresInSeconds).toBe(900)
  })

  it('leaves verificationUriComplete absent when GitHub does not return one', async () => {
    const { fetchImpl } = jsonFetch({ device_code: 'd', user_code: 'U', verification_uri: 'https://x' })
    const grant = await startDeviceFlow(fetchImpl, 'github.com', 'client-1')
    expect('verificationUriComplete' in grant).toBe(false)
  })

  it('rejects an answer without a device code', async () => {
    const { fetchImpl } = jsonFetch({ error: 'device_flow_disabled' })
    await expect(startDeviceFlow(fetchImpl, 'github.com', 'client-1')).rejects.toThrow(/did not return a device code/)
  })

  it('rejects a non-JSON answer', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    await expect(startDeviceFlow(fetchImpl, 'github.com', 'client-1')).rejects.toThrow(/non-JSON/)
  })

  it('rejects a non-2xx answer', async () => {
    const { fetchImpl } = jsonFetch({ message: 'too many requests' }, 429)
    await expect(startDeviceFlow(fetchImpl, 'github.com', 'client-1')).rejects.toThrow(/HTTP 429/)
  })

  it('rejects a dead connection', async () => {
    await expect(startDeviceFlow(brokenFetch(), 'github.com', 'client-1')).rejects.toThrow(/could not be reached/)
  })
})

describe('pollDeviceFlow', () => {
  it('returns the token from an approved grant', async () => {
    const { fetchImpl, calls } = jsonFetch(APPROVED)
    await expect(pollDeviceFlow(fetchImpl, 'github.com', 'client-1', 'dev-code-1')).resolves.toEqual({
      status: 'token',
      token: 'gho_token',
    })
    expect(calls[0]?.url).toBe('https://github.com/login/oauth/access_token')
    const form = new URLSearchParams(calls[0]?.body ?? '')
    expect(form.get('device_code')).toBe('dev-code-1')
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    // No client secret, ever: the device grant authenticates with the id alone.
    expect(form.has('client_secret')).toBe(false)
  })

  it('maps authorization_pending to pending', async () => {
    const { fetchImpl } = jsonFetch({ error: 'authorization_pending' }, 400)
    await expect(pollDeviceFlow(fetchImpl, 'github.com', 'c', 'd')).resolves.toEqual({ status: 'pending' })
  })

  it('maps slow_down to slow_down (the dialog backs off)', async () => {
    const { fetchImpl } = jsonFetch({ error: 'slow_down' }, 400)
    await expect(pollDeviceFlow(fetchImpl, 'github.com', 'c', 'd')).resolves.toEqual({ status: 'slow_down' })
  })

  it('maps expired_token to expired with GitHub description', async () => {
    const { fetchImpl } = jsonFetch({ error: 'expired_token', error_description: 'expired' }, 400)
    await expect(pollDeviceFlow(fetchImpl, 'github.com', 'c', 'd')).resolves.toEqual({ status: 'expired', message: 'expired' })
  })

  it('maps access_denied to denied', async () => {
    const { fetchImpl } = jsonFetch({ error: 'access_denied', error_description: 'user denied' }, 400)
    await expect(pollDeviceFlow(fetchImpl, 'github.com', 'c', 'd')).resolves.toEqual({ status: 'denied', message: 'user denied' })
  })

  it('maps an unknown error code to failed', async () => {
    const { fetchImpl } = jsonFetch({ error: 'incorrect_client_credentials' }, 400)
    await expect(pollDeviceFlow(fetchImpl, 'github.com', 'c', 'd')).resolves.toEqual({
      status: 'failed',
      message: 'incorrect_client_credentials',
    })
  })

  it('rejects a dead connection', async () => {
    await expect(pollDeviceFlow(brokenFetch(), 'github.com', 'c', 'd')).rejects.toThrow(/could not be reached/)
  })
})

describe('deviceFlowClientId', () => {
  it('defaults to the shipped app id', () => {
    expect(deviceFlowClientId({})).toBe(DEFAULT_OAUTH_CLIENT_ID)
  })

  it('prefers DSH_GITHUB_OAUTH_CLIENT_ID', () => {
    expect(deviceFlowClientId({ DSH_GITHUB_OAUTH_CLIENT_ID: ' own-id ' })).toBe('own-id')
  })

  it('falls back when the override is blank', () => {
    expect(deviceFlowClientId({ DSH_GITHUB_OAUTH_CLIENT_ID: '   ' })).toBe(DEFAULT_OAUTH_CLIENT_ID)
  })
})

describe('isDeviceFlowHost', () => {
  it('accepts every implemented host and nothing else', () => {
    expect(DEVICE_FLOW_HOSTS).toContain('github.com')
    expect(isDeviceFlowHost('github.com')).toBe(true)
    expect(isDeviceFlowHost('gitlab.com')).toBe(false)
    expect(isDeviceFlowHost('GitHub.com')).toBe(false)
  })
})

/** Minimal host deps for the two credential routes. */
function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    exec: async () => {
      throw new Error('unexpected git call')
    },
    sectionRootDir: () => undefined,
    sectionFetchBeforeCreate: () => undefined,
    home: () => '/home/u',
    envHome: () => undefined,
    ...over,
  }
}

/** An in-memory credential store; `entries()` reads the current state. */
function memStore(initial: GitCredential[] = []): { store: CredentialStore; entries: () => GitCredential[] } {
  let entries = [...initial]
  return {
    store: {
      path: '/home/u/.dsh/git-credentials.json',
      load: async () => [...entries],
      save: async next => {
        entries = [...next]
      },
    },
    entries: () => entries,
  }
}

/** The error text of a failure envelope (routes answer `{ error }`). */
function errorText(outcome: Awaited<ReturnType<typeof handleCredentialsOAuthStart>>): string {
  const body = outcome.body as { error?: string }
  return typeof body.error === 'string' ? body.error : ''
}

describe('handleCredentialsOAuthStart', () => {
  it('rejects a missing or blank host', async () => {
    expect((await handleCredentialsOAuthStart(deps(), {})).status).toBe(400)
    expect((await handleCredentialsOAuthStart(deps(), { host: '  ' })).status).toBe(400)
  })

  it('rejects a host without browser sign-in', async () => {
    const { fetchImpl } = jsonFetch(GRANT)
    const outcome = await handleCredentialsOAuthStart(deps({ fetchImpl }), { host: 'gitlab.com' })
    expect(outcome.status).toBe(400)
    expect(errorText(outcome)).toContain('not available')
  })

  it('answers the grant for github.com', async () => {
    const { fetchImpl } = jsonFetch(GRANT)
    const outcome = await handleCredentialsOAuthStart(deps({ fetchImpl }), { host: 'GitHub.com' })
    expect(outcome.status).toBe(200)
    const body = outcome.body as Record<string, unknown>
    expect(body.userCode).toBe('ABCD-1234')
    expect(body.deviceCode).toBe('dev-code-1')
    expect(body.verificationUriComplete).toBe(GRANT.verification_uri_complete)
    expect(body.intervalSeconds).toBe(5)
    expect(body.expiresInSeconds).toBe(900)
  })

  it('surfaces a network failure as 502', async () => {
    const outcome = await handleCredentialsOAuthStart(deps({ fetchImpl: brokenFetch() }), { host: 'github.com' })
    expect(outcome.status).toBe(502)
    expect(errorText(outcome)).toContain('could not start the browser sign-in')
  })
})

describe('handleCredentialsOAuthPoll', () => {
  it('rejects a missing device code', async () => {
    const outcome = await handleCredentialsOAuthPoll(deps(), { host: 'github.com' })
    expect(outcome.status).toBe(400)
  })

  it('rejects a host without browser sign-in', async () => {
    const { fetchImpl } = jsonFetch(APPROVED)
    const outcome = await handleCredentialsOAuthPoll(deps({ fetchImpl }), { host: 'gitlab.com', deviceCode: 'd' })
    expect(outcome.status).toBe(400)
  })

  it('answers pending while the grant waits', async () => {
    const { fetchImpl } = jsonFetch({ error: 'authorization_pending' }, 400)
    const outcome = await handleCredentialsOAuthPoll(deps({ fetchImpl }), { host: 'github.com', deviceCode: 'd' })
    expect(outcome).toEqual({ status: 200, body: { status: 'pending' } })
  })

  it('answers slow_down so the dialog backs off', async () => {
    const { fetchImpl } = jsonFetch({ error: 'slow_down' }, 400)
    const outcome = await handleCredentialsOAuthPoll(deps({ fetchImpl }), { host: 'github.com', deviceCode: 'd' })
    expect(outcome).toEqual({ status: 200, body: { status: 'slow_down' } })
  })

  it('stores an approved token and answers the masked list', async () => {
    const { fetchImpl } = jsonFetch(APPROVED)
    const mem = memStore()
    const outcome = await handleCredentialsOAuthPoll(
      deps({ fetchImpl, credentialsStore: mem.store }),
      { host: 'github.com', deviceCode: 'd' },
    )
    expect(outcome.status).toBe(200)
    const body = outcome.body as { status: string; credentials: Array<{ host: string; username: string; method: string; secretMask: string }> }
    expect(body.status).toBe('done')
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0]?.host).toBe('github.com')
    expect(body.credentials[0]?.method).toBe('token')
    // The raw token stays host-side: the wire only carries the mask.
    expect(body.credentials[0]?.secretMask).not.toContain('gho_token')
    const stored = mem.entries()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.secret).toBe('gho_token')
    expect(stored[0]?.username).toBe('')
    expect(stored[0]?.method).toBe('token')
  })

  it('replaces a previous credential for the same host', async () => {
    const { fetchImpl } = jsonFetch(APPROVED)
    const mem = memStore([{ host: 'github.com', username: 'old', secret: 'ghp_old', method: 'token', updatedAt: 1 }])
    await handleCredentialsOAuthPoll(deps({ fetchImpl, credentialsStore: mem.store }), { host: 'github.com', deviceCode: 'd' })
    const stored = mem.entries()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.secret).toBe('gho_token')
  })

  it('maps a denied grant to 400 with GitHub message', async () => {
    const { fetchImpl } = jsonFetch({ error: 'access_denied', error_description: 'user denied' }, 400)
    const outcome = await handleCredentialsOAuthPoll(deps({ fetchImpl }), { host: 'github.com', deviceCode: 'd' })
    expect(outcome.status).toBe(400)
    expect(errorText(outcome)).toContain('user denied')
  })

  it('surfaces a poll network failure as 502', async () => {
    const outcome = await handleCredentialsOAuthPoll(deps({ fetchImpl: brokenFetch() }), { host: 'github.com', deviceCode: 'd' })
    expect(outcome.status).toBe(502)
    expect(errorText(outcome)).toContain('could not poll the browser sign-in')
  })

  it('surfaces a corrupt store as 500', async () => {
    const { fetchImpl } = jsonFetch(APPROVED)
    const store: CredentialStore = {
      path: '/home/u/.dsh/git-credentials.json',
      load: async () => {
        throw new Error('git-credentials.json is not valid JSON')
      },
      save: async () => {},
    }
    const outcome = await handleCredentialsOAuthPoll(deps({ fetchImpl, credentialsStore: store }), { host: 'github.com', deviceCode: 'd' })
    expect(outcome.status).toBe(500)
  })
})
