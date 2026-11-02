/**
 * The machine-credential import (decision 0038): candidates come from the
 * user's gitconfig, each is probed through `git credential fill`, and only a
 * helper that actually answers ends up in the store. Nothing here touches the
 * network: every git invocation is faked.
 */

import { describe, expect, it } from 'vitest'
import type { CredentialStore, GitCredential } from '../src/credentials.js'
import { importLocalCredentials, localCredentialHosts, type LocalGit } from '../src/local-import.js'

/** A store whose writes are counted, so "saved once" is observable. */
function memoryStore(initial: readonly GitCredential[] = []): CredentialStore & { saves: number } {
  let entries = [...initial]
  let saves = 0
  const store: CredentialStore & { saves: number } = {
    path: '/mem/.git-credentials',
    async load() { return [...entries] },
    async save(next) { entries = [...next]; saves += 1 },
    get saves() { return saves },
  }
  return store
}

/** Hosts the fake gitconfig names, as `git config --get-regexp` prints them. */
const USER_CONFIG = [
  'credential.https://github.com.helper',
  'credential.https://gitlab.cofco-trust.com.helper',
  'credential.https://GitLab.COM.helper',
  'credential.https://gitee.com.provider',
  'credential.http://plain.example.com.helper',
  'unrelated.key',
].join('\n') + '\n'

interface Answer {
  username?: string
  secret?: string
  error?: string
}

/** Fake git: config answers the fixture, credential fill answers per host. */
function fakeGit(answers: Readonly<Record<string, Answer>>, calls?: { args: string[]; env: NodeJS.ProcessEnv }[]): LocalGit {
  return async (args, input, env) => {
    calls?.push({ args: [...args], env })
    if (args[0] === 'config') return { code: 0, stdout: USER_CONFIG, stderr: '' }
    const host = /host=(.*)/.exec(input)?.[1] ?? ''
    const answer = answers[host]
    if (answer === undefined || answer.error !== undefined) {
      return { code: 128, stdout: '', stderr: answer?.error ?? `fatal: could not read Username for 'https://${host}'` }
    }
    const username = answer.username ?? ''
    return {
      code: 0,
      stdout: `protocol=https\nhost=${host}\nusername=${username}\npassword=${answer.secret ?? ''}\n`,
      stderr: '',
    }
  }
}

describe('localCredentialHosts', () => {
  it('reads the URL-scoped hosts of the gitconfig, normalized and deduplicated', async () => {
    const hosts = await localCredentialHosts({ runGit: fakeGit({}) })
    expect(hosts).toEqual(['github.com', 'gitlab.cofco-trust.com', 'gitlab.com', 'gitee.com', 'plain.example.com'])
  })

  it('answers no candidates when git finds no such key', async () => {
    const hosts = await localCredentialHosts({ runGit: async () => ({ code: 1, stdout: '', stderr: '' }) })
    expect(hosts).toEqual([])
  })

  it('probes with prompts disabled and no half-injected config channel', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    await localCredentialHosts({
      runGit: fakeGit({}, calls),
      env: { PATH: '/bin', GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'a.b', GIT_TERMINAL_PROMPT: '1' },
    })
    expect(calls[0]?.args).toEqual(['config', '--get-regexp', '^credential\\.https?://'])
    expect(calls[0]?.env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(calls[0]?.env.GIT_CONFIG_KEY_0).toBeUndefined()
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(calls[0]?.env.GCM_INTERACTIVE).toBe('never')
  })
})

describe('importLocalCredentials', () => {
  it('copies a password helper answer verbatim', async () => {
    const store = memoryStore()
    const report = await importLocalCredentials(store, {
      runGit: fakeGit({ 'github.com': { username: 'octo', secret: 'pat-1' } }),
    }, ['github.com'])
    expect(report.imported).toEqual([{ host: 'github.com', username: 'octo', method: 'password' }])
    expect(report.failed).toEqual([])
    const entries = await store.load()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ host: 'github.com', username: 'octo', secret: 'pat-1', method: 'password' })
    expect(store.saves).toBe(1)
  })

  it('stores an oauth2 helper answer as a token credential with no user name', async () => {
    const store = memoryStore()
    const report = await importLocalCredentials(store, {
      runGit: fakeGit({ 'gitlab.cofco-trust.com': { username: 'oauth2', secret: 'glpat-1' } }),
    }, ['gitlab.cofco-trust.com'])
    expect(report.imported).toEqual([{ host: 'gitlab.cofco-trust.com', username: 'oauth2', method: 'token' }])
    expect((await store.load())[0]).toMatchObject({ username: '', secret: 'glpat-1', method: 'token' })
  })

  it('skips a host the panel already manages without asking the helper', async () => {
    const managed: GitCredential = { host: 'github.com', username: '', secret: 'mine', method: 'token', updatedAt: 1 }
    const store = memoryStore([managed])
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const report = await importLocalCredentials(store, { runGit: fakeGit({}, calls) }, ['github.com', 'gitee.com'])
    expect(report.skipped).toEqual(['github.com'])
    expect(report.imported).toEqual([])
    expect(calls.map(call => call.args[0])).toEqual(['credential'])
    expect(store.saves).toBe(0)
  })

  it('reports a host whose helper answers nothing and leaves the store alone', async () => {
    const store = memoryStore()
    const report = await importLocalCredentials(store, {
      runGit: fakeGit({ 'gitee.com': { error: "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled" } }),
    }, ['gitee.com'])
    expect(report.imported).toEqual([])
    expect(report.failed).toEqual([{
      host: 'gitee.com',
      error: "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
    }])
    expect(store.saves).toBe(0)
  })

  it('writes the store once for a batch and keeps the failed host out of it', async () => {
    const store = memoryStore()
    const report = await importLocalCredentials(store, {
      runGit: fakeGit({ 'github.com': { username: 'octo', secret: 'pat-1' }, 'gitee.com': { error: 'nope' } }),
    }, ['github.com', 'gitee.com'])
    expect(report.imported.map(entry => entry.host)).toEqual(['github.com'])
    expect(report.failed.map(entry => entry.host)).toEqual(['gitee.com'])
    expect(store.saves).toBe(1)
    expect((await store.load()).map(entry => entry.host)).toEqual(['github.com'])
  })

  it('takes the gitconfig hosts when the caller names none, and normalizes them', async () => {
    const store = memoryStore()
    const report = await importLocalCredentials(store, {
      runGit: fakeGit({ 'gitlab.com': { username: 'octo', secret: 'glpat-1' } }),
    })
    // The fixture names five https/http hosts; only gitlab.com answers here.
    expect(report.failed.map(entry => entry.host)).toEqual(['github.com', 'gitlab.cofco-trust.com', 'gitee.com', 'plain.example.com'])
    expect(report.imported.map(entry => entry.host)).toEqual(['gitlab.com'])
  })

  it('accepts a pasted remote URL as an explicit host', async () => {
    const store = memoryStore()
    const report = await importLocalCredentials(store, {
      runGit: fakeGit({ 'github.com': { username: 'octo', secret: 'pat-1' } }),
    }, ['https://GitHub.com/owner/repo.git'])
    expect(report.imported.map(entry => entry.host)).toEqual(['github.com'])
  })
})
