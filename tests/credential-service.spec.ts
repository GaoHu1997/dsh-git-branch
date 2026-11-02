/**
 * The credential service (decision 0037): one store over `~/.git-credentials`
 * plus the generated `[include]` section that makes every git process — the
 * plugin's own and a plain shell — resolve a managed host through
 * `credential-store`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  credentialFilePath,
  credentialIncludeFile,
  gitCredentialsFile,
  type CredentialStore,
  type GitCredential,
} from '../src/credentials.ts'
import { createCredentialService } from '../src/credential-service.ts'

function credential(host: string): GitCredential {
  return { host, username: '', secret: `token-for-${host}`, method: 'token', updatedAt: 1 }
}

function storeOf(entries: readonly GitCredential[] | (() => never)): CredentialStore {
  return {
    path: 'C:/Users/u/.git-credentials',
    load: async () => (typeof entries === 'function' ? entries() : [...entries]),
    save: async () => undefined,
  }
}

/** A throwaway HOME plus the paths the service derives from it. */
function sandbox(): { home: string; gitconfig: string; include: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cred-service-'))
  return {
    home,
    gitconfig: join(home, '.gitconfig'),
    include: credentialIncludeFile(home, undefined),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

describe('createCredentialService', () => {
  it('uses the injected store, so routes and tools share one instance', () => {
    const store = storeOf([credential('github.com')])
    const service = createCredentialService({ home: () => 'C:/Users/u', envHome: () => undefined, store })
    expect(service.store).toBe(store)
  })

  it('falls back to the local store over the machine credential file', () => {
    const service = createCredentialService({ home: () => 'C:/Users/u', envHome: () => undefined })
    expect(service.store.path).toBe(gitCredentialsFile('C:/Users/u'))
    expect(service.store.path.endsWith('.git-credentials')).toBe(true)
  })

  it('refreshShellEnv writes the include and points ~/.gitconfig at it', async () => {
    const box = sandbox()
    writeFileSync(box.gitconfig, '[user]\n\tname = u\n')
    const env: Record<string, string | undefined> = {}
    const service = createCredentialService({
      home: () => box.home,
      envHome: () => undefined,
      store: storeOf([credential('github.com')]),
      env,
      userGitconfig: box.gitconfig,
    })
    try {
      await service.refreshShellEnv()

      const include = readFileSync(box.include, 'utf8')
      expect(include).toContain('[credential "https://github.com/"]')
      expect(include).toContain('\thelper = store')

      const gitconfig = readFileSync(box.gitconfig, 'utf8')
      expect(gitconfig).toContain('[user]\n\tname = u')
      expect(gitconfig).toContain('[include]')
      expect(gitconfig.replace(/\\/g, '/')).toContain(box.include.replace(/\\/g, '/'))

      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GCM_INTERACTIVE).toBe('never')
      // 0037 rides no environment channel (that was 0032/0034).
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    } finally {
      box.cleanup()
    }
  })

  it('refreshShellEnv is idempotent, so saving twice adds one include line', async () => {
    const box = sandbox()
    const env: Record<string, string | undefined> = {}
    const service = createCredentialService({
      home: () => box.home,
      envHome: () => undefined,
      store: storeOf([credential('github.com')]),
      env,
      userGitconfig: box.gitconfig,
    })
    try {
      await service.refreshShellEnv()
      await service.refreshShellEnv()
      const gitconfig = readFileSync(box.gitconfig, 'utf8')
      expect(gitconfig.match(/\[include\]/g)).toHaveLength(1)
    } finally {
      box.cleanup()
    }
  })

  it('refreshShellEnv writes an empty include for an unreadable store instead of throwing', async () => {
    const box = sandbox()
    const env: Record<string, string | undefined> = {}
    const service = createCredentialService({
      home: () => box.home,
      envHome: () => undefined,
      store: storeOf(() => {
        throw new Error('boom')
      }),
      env,
      userGitconfig: box.gitconfig,
    })
    try {
      await expect(service.refreshShellEnv()).resolves.toBeUndefined()
      const include = readFileSync(box.include, 'utf8')
      expect(include).not.toContain('[credential "')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      box.cleanup()
    }
  })

  it('refreshShellEnv imports the retired plugin-private file once', async () => {
    const box = sandbox()
    const env: Record<string, string | undefined> = {}
    const legacy = credentialFilePath(box.home, undefined)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(box.home, '.dsh'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({
      version: 1,
      credentials: [{ host: 'gitee.com', username: '', secret: 'gitee_tok', method: 'token', updatedAt: 2 }],
    }))
    const service = createCredentialService({
      home: () => box.home,
      envHome: () => undefined,
      env,
      userGitconfig: box.gitconfig,
    })
    try {
      await service.refreshShellEnv()

      expect(existsSync(legacy)).toBe(false)
      expect(readFileSync(gitCredentialsFile(box.home), 'utf8')).toBe('https://oauth2:gitee_tok@gitee.com\n')
      expect(readFileSync(box.include, 'utf8')).toContain('[credential "https://gitee.com/"]')

      await service.refreshShellEnv()
      expect(readFileSync(gitCredentialsFile(box.home), 'utf8')).toBe('https://oauth2:gitee_tok@gitee.com\n')
    } finally {
      box.cleanup()
    }
  })

  it('dispose removes the include, the generated file and the switches', async () => {
    const box = sandbox()
    const env: Record<string, string | undefined> = {}
    const service = createCredentialService({
      home: () => box.home,
      envHome: () => undefined,
      store: storeOf([credential('github.com')]),
      env,
      userGitconfig: box.gitconfig,
    })
    try {
      await service.refreshShellEnv()
      await service.dispose()

      expect(readFileSync(box.gitconfig, 'utf8')).not.toContain('[include]')
      expect(existsSync(box.include)).toBe(false)
      expect(env.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(env.GCM_INTERACTIVE).toBeUndefined()
    } finally {
      box.cleanup()
    }
  })
})
