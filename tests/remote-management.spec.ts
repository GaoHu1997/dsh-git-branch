/**
 * Remote-management and credential-route tests: URL/name validation, the
 * `git remote` verb mapping, masked listings, and the auth header injection
 * every network handler now carries.
 */

import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from '../src/git.ts'
import type { CredentialStore, GitCredential } from '../src/credentials.ts'
import {
  handleCredentials, handleCredentialsDelete, handleCredentialsSave, handleFetch, handleRemote, handleRemotes,
  type RouteDeps,
} from '../src/routes.ts'

/** Repo facts as `probeRepo` reads them for the fictional /repo checkout. */
const REPO_CALLS: Record<string, string> = {
  'rev-parse --show-toplevel': '/repo\n',
  'rev-parse --git-common-dir': '/repo/.git\n',
  'branch --show-current': 'main\n',
  'for-each-ref refs/heads': 'main\n',
  'for-each-ref refs/remotes': '',
  'worktree list --porcelain': 'worktree /repo\nHEAD 1\nbranch refs/heads/main\n',
}

/** The `git remote -v` shape for two remotes. */
const REMOTE_TABLE = [
  'mirror\tgit@gitlab.com:o/r.git (fetch)',
  'mirror\tgit@gitlab.com:o/r.git (push)',
  'origin\thttps://github.com/o/r.git (fetch)',
  'origin\thttps://github.com/o/r.git (push)',
].join('\n')

/** An executor that answers the probe calls and one scripted verb. */
function repoExec(table: Record<string, Partial<ExecResult>>, calls: string[] = []): Exec {
  return async (_file, args) => {
    const key = args.join(' ')
    calls.push(key)
    const repoHit = Object.entries(REPO_CALLS).find(([prefix]) => key === prefix || key.startsWith(prefix) || key.endsWith(prefix))
    if (repoHit !== undefined) {
      return { code: 0, stdout: repoHit[1], stderr: '' } as ExecResult
    }
    const entry = Object.entries(table).find(([prefix]) => key === prefix || key.startsWith(prefix) || key.endsWith(prefix))
    if (entry === undefined) throw new Error(`unexpected git call: git ${key}`)
    return { code: 0, stdout: '', stderr: '', ...entry[1] }
  }
}

/** Minimal deps: exec plus the paths the credential store resolves from. */
function depsWith(exec: Exec, store?: CredentialStore): RouteDeps {
  return {
    exec,
    sectionRootDir: () => undefined,
    sectionFetchBeforeCreate: () => false,
    home: () => '/home/u',
    envHome: () => undefined,
    dirExists: () => true,
    ...(store === undefined ? {} : { credentialsStore: store }),
  }
}

/** depsWith plus a bridge refresh spy the credential routes must call. */
function bridgedDeps(
  exec: Exec,
  store: CredentialStore,
  refresh: () => Promise<void>,
): RouteDeps {
  return { ...depsWith(exec, store), refreshShellBridge: refresh }
}

/** An in-memory credential store the routes can read and write. */
function memoryStore(entries: readonly GitCredential[] = []): CredentialStore {
  let state = [...entries]
  return {
    path: '/mem/git-credentials.json',
    load: async () => state,
    save: async next => { state = [...next] },
  }
}

const GITHUB: GitCredential = { host: 'github.com', username: 'octo', secret: 'ghp_secret', method: 'token', updatedAt: 1 }

describe('handleRemotes', () => {
  it('lists remotes sorted, pairing fetch and push URLs', async () => {
    const exec = repoExec({ 'remote -v': { stdout: `${REMOTE_TABLE}\n` } })
    const result = await handleRemotes(depsWith(exec), { repoPath: '/repo' })
    expect(result).toMatchObject({
      status: 200,
      body: {
        remotes: [
          { name: 'mirror', fetchUrl: 'git@gitlab.com:o/r.git', pushUrl: 'git@gitlab.com:o/r.git' },
          { name: 'origin', fetchUrl: 'https://github.com/o/r.git', pushUrl: 'https://github.com/o/r.git' },
        ],
      },
    })
  })

  it('rejects a relative repoPath and unknown keys', async () => {
    const exec = repoExec({})
    expect((await handleRemotes(depsWith(exec), { repoPath: 'rel' })).status).toBe(400)
    expect((await handleRemotes(depsWith(exec), { repoPath: '/repo', extra: 1 })).status).toBe(400)
  })
})

describe('handleRemote validation', () => {
  it('rejects an unknown action, a bad name and a bad url', async () => {
    const exec = repoExec({})
    expect((await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'push', name: 'origin' })).status).toBe(400)
    expect((await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'add', name: '-x', url: 'https://a.com/r.git' })).status).toBe(400)
    expect((await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'add', name: 'a b', url: 'https://a.com/r.git' })).status).toBe(400)
    expect((await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'add', name: 'up', url: '  ' })).status).toBe(400)
    expect((await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'add', name: 'up', url: 'not a url' })).status).toBe(400)
  })

  it('refuses to add an existing remote and to touch a missing one', async () => {
    const exec = repoExec({ 'remote -v': { stdout: `${REMOTE_TABLE}\n` } })
    const existing = await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'add', name: 'origin', url: 'https://a.com/r.git' })
    expect(existing).toMatchObject({ status: 400 })
    expect((existing.body as { error: string }).error).toContain('already exists')
    const missing = await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'remove', name: 'upstream' })
    expect(missing).toMatchObject({ status: 400 })
    expect((missing.body as { error: string }).error).toContain('does not exist')
  })
})

describe('handleRemote verbs', () => {
  it('adds a remote with the given name and url', async () => {
    const calls: string[] = []
    const exec = repoExec({ 'remote -v': { stdout: `${REMOTE_TABLE}\n` }, 'remote add': {} }, calls)
    const result = await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'add', name: 'up', url: 'https://up.example.com/r.git' })
    expect(result.status).toBe(200)
    expect(calls).toContain('remote add up https://up.example.com/r.git')
  })

  it('rewrites both the fetch and push urls on set-url', async () => {
    const calls: string[] = []
    const exec = repoExec({ 'remote -v': { stdout: `${REMOTE_TABLE}\n` }, 'remote set-url': {} }, calls)
    const result = await handleRemote(depsWith(exec), {
      repoPath: '/repo',
      action: 'set-url',
      name: 'origin',
      url: 'https://gitlab.com/o/r.git',
    })
    expect(result.status).toBe(200)
    expect(calls).toContain('remote set-url origin https://gitlab.com/o/r.git')
    expect(calls).toContain('remote set-url --push origin https://gitlab.com/o/r.git')
  })

  it('removes a remote', async () => {
    const calls: string[] = []
    const exec = repoExec({ 'remote -v': { stdout: `${REMOTE_TABLE}\n` }, 'remote remove': {} }, calls)
    const result = await handleRemote(depsWith(exec), { repoPath: '/repo', action: 'remove', name: 'mirror' })
    expect(result.status).toBe(200)
    expect(calls).toContain('remote remove mirror')
  })
})

describe('credential routes', () => {
  it('lists masked entries without the secret', async () => {
    const result = await handleCredentials(depsWith(repoExec({}), memoryStore([GITHUB])), {})
    expect(result).toMatchObject({
      status: 200,
      body: { credentials: [{ host: 'github.com', username: 'octo', method: 'token', secretMask: '****cret' }] },
    })
    expect(JSON.stringify(result.body)).not.toContain('ghp_secret')
  })

  it('normalizes the host and requires a secret for a new host', async () => {
    const store = memoryStore()
    const missing = await handleCredentialsSave(depsWith(repoExec({}), store), { host: 'github.com', username: 'u', method: 'token' })
    expect(missing).toMatchObject({ status: 400 })
    expect((missing.body as { error: string }).error).toContain('"secret" is required')

    const saved = await handleCredentialsSave(depsWith(repoExec({}), store), {
      host: 'GitHub.com',
      username: 'octo',
      method: 'token',
      secret: 'ghp_new',
    })
    expect(saved).toMatchObject({ status: 200, body: { credentials: [{ host: 'github.com', username: 'octo' }] } })
    expect(await store.load()).toMatchObject([{ host: 'github.com', secret: 'ghp_new' }])
  })

  it('keeps the stored secret when the field is omitted', async () => {
    const store = memoryStore([GITHUB])
    const result = await handleCredentialsSave(depsWith(repoExec({}), store), {
      host: 'github.com',
      username: 'octo',
      method: 'password',
    })
    expect(result.status).toBe(200)
    expect(await store.load()).toMatchObject([{ secret: 'ghp_secret', username: 'octo', method: 'password' }])
  })

  it('rejects an invalid host and method, and a password without a username', async () => {
    const store = memoryStore()
    const deps = depsWith(repoExec({}), store)
    expect((await handleCredentialsSave(deps, { host: ' ', username: 'u', method: 'token', secret: 's' })).status).toBe(400)
    expect((await handleCredentialsSave(deps, { host: 'bad host', username: 'u', method: 'token', secret: 's' })).status).toBe(400)
    expect((await handleCredentialsSave(deps, { host: 'a.com', username: 'u', method: 'ssh', secret: 's' })).status).toBe(400)
    expect((await handleCredentialsSave(deps, { host: 'a.com', username: ' ', method: 'password', secret: 's' })).status).toBe(400)
  })

  it('stores a token without a username', async () => {
    const store = memoryStore()
    const saved = await handleCredentialsSave(depsWith(repoExec({}), store), { host: 'gitee.com', username: '', method: 'token', secret: 'tok' })
    expect(saved).toMatchObject({ status: 200, body: { credentials: [{ host: 'gitee.com', username: '' }] } })
    expect(await store.load()).toMatchObject([{ host: 'gitee.com', username: '', method: 'token' }])
  })

  it('deletes only a stored host', async () => {
    const store = memoryStore([GITHUB])
    const missing = await handleCredentialsDelete(depsWith(repoExec({}), store), { host: 'gitlab.com' })
    expect(missing).toMatchObject({ status: 400 })
    const removed = await handleCredentialsDelete(depsWith(repoExec({}), store), { host: 'github.com' })
    expect(removed).toMatchObject({ status: 200, body: { credentials: [] } })
    expect(await store.load()).toEqual([])
  })

  it('re-derives the shell bridge after a save and after a delete', async () => {
    const store = memoryStore()
    let refreshes = 0
    const deps = bridgedDeps(repoExec({}), store, async () => { refreshes += 1 })
    await handleCredentialsSave(deps, { host: 'github.com', username: 'octo', method: 'token', secret: 'ghp_x' })
    expect(refreshes).toBe(1)
    await handleCredentialsDelete(deps, { host: 'github.com' })
    expect(refreshes).toBe(2)
  })

  it('keeps the saved credential when the bridge refresh fails', async () => {
    const store = memoryStore()
    const deps = bridgedDeps(repoExec({}), store, async () => { throw new Error('bridge exploded') })
    const saved = await handleCredentialsSave(deps, { host: 'github.com', username: 'octo', method: 'token', secret: 'ghp_x' })
    // The store write is the user's intent; a broken environment refresh must
    // not turn a successful save into an error dialog.
    expect(saved.status).toBe(200)
    expect(await store.load()).toMatchObject([{ host: 'github.com', secret: 'ghp_x' }])
  })

  it('does not refresh the bridge for a rejected request', async () => {
    const store = memoryStore()
    let refreshes = 0
    const deps = bridgedDeps(repoExec({}), store, async () => { refreshes += 1 })
    expect((await handleCredentialsSave(deps, { host: 'github.com', username: 'u', method: 'token' })).status).toBe(400)
    expect((await handleCredentialsDelete(deps, { host: 'gitlab.com' })).status).toBe(400)
    expect(refreshes).toBe(0)
  })
})

describe('auth injection', () => {
  it('prefixes the fetch with the stored host header', async () => {
    const calls: string[] = []
    const exec = repoExec({ 'fetch --all --prune': {} }, calls)
    const result = await handleFetch(depsWith(exec, memoryStore([GITHUB])), { repoPath: '/repo' })
    expect(result.status).toBe(200)
    const encoded = Buffer.from('octo:ghp_secret').toString('base64')
    const fetchCall = calls.find(call => call.endsWith('fetch --all --prune'))
    expect(fetchCall).toBe(`-c http.https://github.com/.extraHeader=AUTHORIZATION: basic ${encoded} fetch --all --prune`)
  })

  it('still fetches when the credential store is unreadable', async () => {
    const broken: CredentialStore = {
      path: '/mem/git-credentials.json',
      load: async () => { throw new Error('unreadable') },
      save: async () => {},
    }
    const calls: string[] = []
    const exec = repoExec({ 'fetch --all --prune': {} }, calls)
    const result = await handleFetch(depsWith(exec, broken), { repoPath: '/repo' })
    expect(result.status).toBe(200)
    expect(calls.some(call => call === 'fetch --all --prune')).toBe(true)
  })
})
