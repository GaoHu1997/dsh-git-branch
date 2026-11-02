/**
 * Shell bridge tests (decision 0037): the module no longer injects anything
 * into the process environment — it generates the URL-scoped `helper = store`
 * include, installs one `[include]` line into `~/.gitconfig`, keeps the
 * fail-fast switches, and cleans up the retired 0032 channel.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialIncludeFile, type CredentialStore, type GitCredential } from '../src/credentials.ts'
import { LEGACY_COUNT_ENV, createShellBridge, legacyConfigNames } from '../src/shell-bridge.ts'

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

/** A throwaway HOME, an isolated env object, and the bridge over both. */
function setup(entries: readonly GitCredential[] | (() => never) = [credential('github.com')]): {
  home: string
  gitconfig: string
  include: string
  env: Record<string, string | undefined>
  bridge: ReturnType<typeof createShellBridge>
  cleanup: () => void
} {
  const home = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
  const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
  return {
    home,
    gitconfig: join(home, '.gitconfig'),
    include: credentialIncludeFile(home, undefined),
    env,
    bridge: createShellBridge({ home: () => home, envHome: () => undefined, store: storeOf(entries), env }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

describe('legacyConfigNames', () => {
  it('reports nothing when the retired channel is absent', () => {
    expect(legacyConfigNames({})).toEqual([])
  })

  it('reports a half-injected channel: count and values survive, KEYs are scrubbed', () => {
    const env = {
      [LEGACY_COUNT_ENV]: '2',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_VALUE_1: '!node "bridge.js"',
      PATH: '/usr/bin',
    }
    expect([...legacyConfigNames(env)].sort()).toEqual([
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_VALUE_1',
    ])
  })

  it('reports the surviving KEY name of an incomplete pair', () => {
    const env = { [LEGACY_COUNT_ENV]: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }
    expect(legacyConfigNames(env)).toContain('GIT_CONFIG_KEY_0')
  })

  it('leaves a complete caller-set channel alone — that is valid git input', () => {
    const env = { [LEGACY_COUNT_ENV]: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' }
    expect(legacyConfigNames(env)).toEqual([])
  })

  it('treats a non-numeric count as broken', () => {
    const env = { [LEGACY_COUNT_ENV]: 'many', GIT_CONFIG_VALUE_0: 'x' }
    expect(legacyConfigNames(env)).toContain('GIT_CONFIG_VALUE_0')
  })
})

describe('createShellBridge', () => {
  it('apply generates the include and installs one include line into ~/.gitconfig', async () => {
    const box = setup([credential('github.com'), credential('gitee.com')])
    try {
      await box.bridge.apply()

      expect(box.bridge.configPath()).toBe(box.include)
      const include = readFileSync(box.include, 'utf8')
      expect(include).toContain('[credential "https://github.com/"]')
      expect(include).toContain('[credential "https://gitee.com/"]')
      expect(include.match(/\thelper = store/g)).toHaveLength(2)

      const gitconfig = readFileSync(box.gitconfig, 'utf8')
      expect(gitconfig.match(/\[include\]/g)).toHaveLength(1)
      expect(gitconfig.replace(/\\/g, '/')).toContain(box.include.replace(/\\/g, '/'))
    } finally {
      box.cleanup()
    }
  })

  it('apply keeps only the fail-fast switches — no environment channel', async () => {
    const box = setup()
    try {
      await box.bridge.apply()
      expect(box.env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(box.env.GCM_INTERACTIVE).toBe('never')
      expect(box.env.GIT_CONFIG_GLOBAL).toBeUndefined()
      expect(box.env.GIT_CONFIG_COUNT).toBeUndefined()
      expect(box.env.DGB_BRIDGE_HELPER).toBeUndefined()
    } finally {
      box.cleanup()
    }
  })

  it('re-apply drops a host that no longer has a credential', async () => {
    const box = setup([credential('github.com'), credential('gitee.com')])
    try {
      await box.bridge.apply()
      expect(readFileSync(box.include, 'utf8')).toContain('gitee.com')

      const shrunk = createShellBridge({
        home: () => box.home,
        envHome: () => undefined,
        store: storeOf([credential('github.com')]),
        env: box.env,
      })
      await shrunk.apply()
      const include = readFileSync(box.include, 'utf8')
      expect(include).toContain('github.com')
      expect(include).not.toContain('gitee.com')
    } finally {
      box.cleanup()
    }
  })

  it('a broken store still writes an empty include and keeps the fail-fast switches', async () => {
    const box = setup(() => {
      throw new Error('boom')
    })
    try {
      await expect(box.bridge.apply()).resolves.toBeUndefined()
      expect(readFileSync(box.include, 'utf8')).not.toContain('[credential "')
      expect(box.env.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      box.cleanup()
    }
  })

  it('an include path that cannot be written is swallowed, and fail-fast still applies', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
    try {
      const blocker = join(home, 'not-a-dir')
      writeFileSync(blocker, 'x')
      const env: Record<string, string | undefined> = {}
      const bridge = createShellBridge({
        home: () => home,
        envHome: () => blocker,
        store: storeOf([credential('github.com')]),
        env,
      })
      await expect(bridge.apply()).resolves.toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(existsSync(join(blocker, 'git-credentials.include.gitconfig'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('apply deletes the retired 0032 channel left in the host environment', async () => {
    const box = setup()
    box.env[LEGACY_COUNT_ENV] = '2'
    box.env.GIT_CONFIG_VALUE_0 = ''
    box.env.GIT_CONFIG_VALUE_1 = '!node "bridge.js"'
    try {
      await box.bridge.apply()
      expect(box.env[LEGACY_COUNT_ENV]).toBeUndefined()
      expect(box.env.GIT_CONFIG_VALUE_0).toBeUndefined()
      expect(box.env.GIT_CONFIG_VALUE_1).toBeUndefined()
      // Only the channel goes: unrelated variables survive.
      expect(box.env.PATH).toBe('/usr/bin')
    } finally {
      box.cleanup()
    }
  })

  it('apply deletes the leftovers even when the include cannot be written', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
    try {
      const blocker = join(home, 'not-a-dir')
      writeFileSync(blocker, 'x')
      const env: Record<string, string | undefined> = {
        [LEGACY_COUNT_ENV]: '1',
        GIT_CONFIG_VALUE_0: '!node "bridge.js"',
      }
      const bridge = createShellBridge({
        home: () => home,
        envHome: () => blocker,
        store: storeOf([credential('github.com')]),
        env,
      })
      await bridge.apply()
      // A broken legacy channel breaks git on its own, write failure or not.
      expect(env[LEGACY_COUNT_ENV]).toBeUndefined()
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('dispose removes the include line, the generated file and the switches', async () => {
    const box = setup()
    try {
      writeFileSync(box.gitconfig, '[user]\n\tname = u\n')
      await box.bridge.apply()
      expect(existsSync(box.include)).toBe(true)

      await box.bridge.dispose()

      const gitconfig = readFileSync(box.gitconfig, 'utf8')
      expect(gitconfig).not.toContain('[include]')
      expect(gitconfig).toContain('[user]')
      expect(existsSync(box.include)).toBe(false)
      expect(box.env.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(box.env.GCM_INTERACTIVE).toBeUndefined()
    } finally {
      box.cleanup()
    }
  })

  it('dispose is idempotent and tolerates a missing gitconfig', async () => {
    const box = setup()
    try {
      await box.bridge.apply()
      await box.bridge.dispose()
      await expect(box.bridge.dispose()).resolves.toBeUndefined()
    } finally {
      box.cleanup()
    }
  })
})
