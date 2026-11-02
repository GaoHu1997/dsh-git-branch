import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialFilePath, type CredentialStore, type GitCredential } from '../src/credentials.ts'
import { createCredentialService } from '../src/credential-service.ts'
import { BRIDGE_HELPER_ENV, SESSION_GITCONFIG_ENV } from '../src/shell-bridge.ts'

const HELPER = 'C:/Users/u/lib/helpers/git-credential-bridge.js'
const NODE = 'C:/Program Files/nodejs/node.exe'
const FILE = 'C:/Users/u/.dsh/git-credentials.json'

function credential(host: string): GitCredential {
  return { host, username: '', secret: `token-for-${host}`, method: 'token', updatedAt: 1 }
}

function storeOf(entries: readonly GitCredential[] | (() => never)): CredentialStore {
  return {
    path: FILE,
    load: async () => (typeof entries === 'function' ? entries() : [...entries]),
    save: async () => undefined,
  }
}

describe('createCredentialService', () => {
  it('uses the injected store, so routes and tools share one instance', () => {
    const store = storeOf([credential('github.com')])
    const service = createCredentialService({ home: () => 'C:/Users/u', envHome: () => undefined, store })
    expect(service.store).toBe(store)
  })

  it('falls back to the fs-backed store at the resolved dsh home', () => {
    const service = createCredentialService({ home: () => 'C:/Users/u', envHome: () => undefined })
    expect(service.store.path.endsWith('git-credentials.json')).toBe(true)
  })

  it('authConfigArgs turns stored credentials into `-c extraHeader` pairs', async () => {
    const service = createCredentialService({
      home: () => 'C:/Users/u',
      envHome: () => undefined,
      store: storeOf([credential('github.com')]),
    })
    const args = await service.authConfigArgs()
    expect(args.length).toBeGreaterThan(0)
    expect(args[0]).toBe('-c')
    expect(args[1]).toContain('http.https://github.com/.extraHeader=')
    expect(args[1]).toContain('AUTHORIZATION: basic ')
  })

  it('authConfigArgs degrades to empty on an unreadable store', async () => {
    const service = createCredentialService({
      home: () => 'C:/Users/u',
      envHome: () => undefined,
      store: storeOf(() => {
        throw new Error('boom')
      }),
    })
    expect(await service.authConfigArgs()).toEqual([])
  })

  it('refreshShellEnv injects the session config and writes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cred-service-'))
    const configPath = join(dir, 'session.gitconfig')
    const env: Record<string, string | undefined> = {}
    const service = createCredentialService({
      home: () => 'C:/Users/u',
      envHome: () => undefined,
      store: storeOf([credential('github.com')]),
      env,
      configPath,
      helperPath: HELPER,
      nodePath: NODE,
    })
    try {
      await service.refreshShellEnv()
      expect(env[SESSION_GITCONFIG_ENV]).toBe(configPath)
      expect(env[BRIDGE_HELPER_ENV]).toBe(credentialFilePath('C:/Users/u', undefined))
      const body = readFileSync(configPath, 'utf8')
      expect(body).toContain('[credential "https://github.com/"]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dispose undoes the injection and deletes the config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cred-service-'))
    const configPath = join(dir, 'session.gitconfig')
    const env: Record<string, string | undefined> = {}
    const service = createCredentialService({
      home: () => 'C:/Users/u',
      envHome: () => undefined,
      store: storeOf([credential('github.com')]),
      env,
      configPath,
      helperPath: HELPER,
      nodePath: NODE,
    })
    try {
      await service.refreshShellEnv()
      await service.dispose()
      expect(env[SESSION_GITCONFIG_ENV]).toBeUndefined()
      expect(existsSync(configPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
