import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialFilePath, type CredentialStore, type GitCredential } from '../src/credentials.ts'
import {
  BRIDGE_HELPER_ENV,
  LEGACY_COUNT_ENV,
  SESSION_GITCONFIG_ENV,
  bridgeCommand,
  createShellBridge,
  gitconfigEscape,
  legacyConfigNames,
  sessionGitconfigBody,
  shellQuote,
  shellBridgeEnv,
} from '../src/shell-bridge.ts'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const HELPER = 'C:\\Users\\u\\.dsh\\profiles\\desktop\\node_modules\\dsh-git-branch-manage\\lib\\helpers\\git-credential-bridge.js'
const FILE = 'C:/Users/u/.dsh/git-credentials.json'
const USER_GITCONFIG = 'C:/Users/u/.gitconfig'

/** One stored credential with the fields the bridge only reads `host` from. */
function credential(host: string): GitCredential {
  return { host, username: '', secret: `token-for-${host}`, method: 'token', updatedAt: 1 }
}

/** In-memory store seam (the bridge only calls `load`). */
function storeOf(entries: readonly GitCredential[] | (() => never)): CredentialStore {
  return {
    path: FILE,
    load: async () => (typeof entries === 'function' ? entries() : [...entries]),
    save: async () => undefined,
  }
}

/** The DSH subprocess scrubber's rule (decision 0034) — the reason this
 * channel exists. A name it would strip must never appear in the bridge env. */
function isScrubbed(key: string): boolean {
  return /KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.startsWith('DSH_')
}

describe('shellQuote', () => {
  it('quotes and normalizes backslashes for git\'s `!` shell', () => {
    expect(shellQuote(NODE)).toBe('"C:/Program Files/nodejs/node.exe"')
    expect(shellQuote('/usr/local/bin/node')).toBe('"/usr/local/bin/node"')
  })

  it('keeps a space-containing path as a single quoted token', () => {
    expect(shellQuote(NODE).startsWith('"')).toBe(true)
    expect(shellQuote(NODE).endsWith('"')).toBe(true)
  })
})

describe('bridgeCommand', () => {
  it('is a `!`-prefixed shell command with both paths quoted', () => {
    expect(bridgeCommand(NODE, HELPER)).toBe(`!"C:/Program Files/nodejs/node.exe" "${HELPER.replace(/\\/g, '/')}"`)
  })

  it('starts with `!`, because git does not word-split a helper value', () => {
    // A bare `node "C:/…"` is looked up as the program `git-credential-node`;
    // the `!` prefix is what makes git run it through the shell instead.
    expect(bridgeCommand('node', 'bridge.js').startsWith('!')).toBe(true)
  })
})

describe('gitconfigEscape', () => {
  it('escapes a literal quote so it survives git\'s config parser into `sh`', () => {
    expect(gitconfigEscape('say "hi"')).toBe('say \\"hi\\"')
  })

  it('leaves an unquoted value untouched', () => {
    expect(gitconfigEscape('!node bridge.js')).toBe('!node bridge.js')
  })

  it('escapes the quotes of a real bridge command, keeping paths intact', () => {
    const escaped = gitconfigEscape(bridgeCommand(NODE, HELPER))
    // The space in `C:/Program Files/…` must stay inside one escaped-quoted
    // token, or `sh` splits it and git fails to launch the helper at all.
    expect(escaped).toContain(String.raw`\"C:/Program Files/nodejs/node.exe\"`)
    expect(escaped.startsWith('!')).toBe(true)
  })
})

describe('sessionGitconfigBody', () => {
  const command = gitconfigEscape(bridgeCommand(NODE, HELPER))

  it('includes the user config read-only and resets the whole helper list', () => {
    const body = sessionGitconfigBody([], { nodePath: NODE, helperPath: HELPER, userGitconfig: USER_GITCONFIG })
    expect(body).toContain('[include]')
    expect(body).toContain('path = C:/Users/u/.gitconfig')
    // Even with no stored host the machine chain is cut, so an unknown host
    // fails fast instead of opening a GUI dialog no agent shell can answer.
    expect(body).toContain('[credential]')
    expect(body).toContain('helper =')
  })

  it('omits the include when no user config is given', () => {
    const body = sessionGitconfigBody([], { nodePath: NODE, helperPath: HELPER })
    expect(body).not.toContain('[include]')
  })

  it('writes a URL-scoped reset then the bridge command per host', () => {
    const body = sessionGitconfigBody(['github.com'], { nodePath: NODE, helperPath: HELPER, userGitconfig: USER_GITCONFIG })
    expect(body).toContain('[credential "https://github.com/"]')
    // Empty helper first resets whatever the included user config accumulated
    // for this URL (the local `gh` helper), then the bridge takes over.
    expect(body).toContain(`helper = ${command}`)
    const scope = body.slice(body.indexOf('[credential "https://github.com/"]'))
    expect(scope.indexOf('helper =')).toBeLessThan(scope.indexOf(`helper = ${command}`))
  })

  it('deduplicates hosts', () => {
    const body = sessionGitconfigBody(['github.com', 'github.com', 'gitlab.com'], { nodePath: NODE, helperPath: HELPER })
    expect(body.match(/\[credential "https:\/\/github\.com\/"\]/g)).toHaveLength(1)
    expect(body).toContain('[credential "https://gitlab.com/"]')
  })

  it('escapes the helper command so quotes reach `sh` intact', () => {
    const body = sessionGitconfigBody(['github.com'], { nodePath: NODE, helperPath: HELPER })
    expect(body).toContain(`helper = ${command}`)
  })
})

describe('shellBridgeEnv', () => {
  const assignments = shellBridgeEnv({ configPath: '/tmp/x.gitconfig', credentialFile: FILE })
  const keys = assignments.map(([key]) => key)

  it('points git at the session config and carries the credential file', () => {
    expect(assignments).toContainEqual([SESSION_GITCONFIG_ENV, '/tmp/x.gitconfig'])
    expect(assignments).toContainEqual([BRIDGE_HELPER_ENV, FILE])
  })

  it('always keeps the fail-fast switches', () => {
    expect(assignments).toContainEqual(['GIT_TERMINAL_PROMPT', '0'])
    expect(assignments).toContainEqual(['GCM_INTERACTIVE', 'never'])
  })

  it('every name survives the DSH scrubber (no KEY/PASSWORD/SECRET/TOKEN, no DSH_)', () => {
    for (const key of keys) expect(isScrubbed(key)).toBe(false)
  })

  it('carries no legacy GIT_CONFIG_COUNT/KEY_n/VALUE_n entry', () => {
    for (const key of keys) expect(key).not.toMatch(/GIT_CONFIG_(COUNT|KEY_|VALUE_)/)
  })
})

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
  function setup(entries: readonly GitCredential[] | (() => never)) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
    const configPath = join(dir, 'session.gitconfig')
    const env: Record<string, string | undefined> = {}
    const bridge = createShellBridge({
      home: () => 'C:/Users/u',
      envHome: () => undefined,
      store: storeOf(entries),
      env,
      configPath,
      helperPath: HELPER,
      nodePath: NODE,
      userGitconfig: USER_GITCONFIG,
    })
    return { dir, configPath, env, bridge }
  }

  it('apply writes the session config and injects the environment', async () => {
    const { dir, configPath, env, bridge } = setup([credential('github.com')])
    try {
      await bridge.apply()
      expect(existsSync(configPath)).toBe(true)
      const body = readFileSync(configPath, 'utf8')
      expect(body).toContain('[credential "https://github.com/"]')
      expect(env[SESSION_GITCONFIG_ENV]).toBe(configPath)
      expect(env[BRIDGE_HELPER_ENV]).toBe(credentialFilePath('C:/Users/u', undefined))
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(bridge.configPath()).toBe(configPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a broken store still resets the helper list (fail fast, no dialog)', async () => {
    const { dir, configPath, env, bridge } = setup(() => {
      throw new Error('boom')
    })
    try {
      await bridge.apply()
      const body = readFileSync(configPath, 'utf8')
      expect(body).not.toContain('[credential "https://')
      expect(body).toContain('helper =')
      // The config is still written and pointed at, so the reset lands.
      expect(env[SESSION_GITCONFIG_ENV]).toBe(configPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a config that cannot be written drops GIT_CONFIG_GLOBAL but keeps fail-fast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
    try {
      // Make the parent a FILE so mkdirSync(dirname) throws.
      const blocker = join(dir, 'not-a-dir')
      writeFileSync(blocker, 'x')
      const env: Record<string, string | undefined> = {}
      const bridge = createShellBridge({
        home: () => 'C:/Users/u',
        envHome: () => undefined,
        store: storeOf([credential('github.com')]),
        env,
        configPath: join(blocker, 'session.gitconfig'),
        helperPath: HELPER,
        nodePath: NODE,
      })
      await bridge.apply()
      expect(env[SESSION_GITCONFIG_ENV]).toBeUndefined()
      // Fail-fast still goes out: a shell git runs unauthenticated, never hangs.
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GCM_INTERACTIVE).toBe('never')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-apply removes stale keys and drops a deleted host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
    const configPath = join(dir, 'session.gitconfig')
    const env: Record<string, string | undefined> = {}
    let hosts = [credential('github.com')]
    const bridge = createShellBridge({
      home: () => 'C:/Users/u',
      envHome: () => undefined,
      store: storeOf(() => hosts.map(h => h)),
      env,
      configPath,
      helperPath: HELPER,
      nodePath: NODE,
      userGitconfig: USER_GITCONFIG,
    })
    try {
      await bridge.apply()
      expect(readFileSync(configPath, 'utf8')).toContain('[credential "https://github.com/"]')
      hosts = []
      await bridge.apply()
      const body = readFileSync(configPath, 'utf8')
      expect(body).not.toContain('[credential "https://github.com/"]')
      expect(env[SESSION_GITCONFIG_ENV]).toBe(configPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('apply deletes the retired 0032 channel left in the host environment', async () => {
    const { dir, configPath, env, bridge } = setup([credential('github.com')])
    env[LEGACY_COUNT_ENV] = '2'
    env.GIT_CONFIG_VALUE_0 = ''
    env.GIT_CONFIG_VALUE_1 = '!node "bridge.js"'
    env.PATH = '/usr/bin'
    try {
      await bridge.apply()
      expect(env[LEGACY_COUNT_ENV]).toBeUndefined()
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()
      expect(env.GIT_CONFIG_VALUE_1).toBeUndefined()
      // Only the channel goes: unrelated variables survive.
      expect(env.PATH).toBe('/usr/bin')
      expect(env[SESSION_GITCONFIG_ENV]).toBe(configPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('apply deletes the leftovers even when the session config cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-branch-test-'))
    try {
      const blocker = join(dir, 'not-a-dir')
      writeFileSync(blocker, 'x')
      const env: Record<string, string | undefined> = {
        [LEGACY_COUNT_ENV]: '1',
        GIT_CONFIG_VALUE_0: '!node "bridge.js"',
      }
      const bridge = createShellBridge({
        home: () => 'C:/Users/u',
        envHome: () => undefined,
        store: storeOf([credential('github.com')]),
        env,
        configPath: join(blocker, 'session.gitconfig'),
        helperPath: HELPER,
        nodePath: NODE,
      })
      await bridge.apply()
      // A broken legacy channel breaks git on its own, write failure or not.
      expect(env[LEGACY_COUNT_ENV]).toBeUndefined()
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dispose clears the environment and deletes the session config', async () => {
    const { dir, configPath, env, bridge } = setup([credential('github.com')])
    try {
      await bridge.apply()
      expect(existsSync(configPath)).toBe(true)
      await bridge.dispose()
      expect(env[SESSION_GITCONFIG_ENV]).toBeUndefined()
      expect(env[BRIDGE_HELPER_ENV]).toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(existsSync(configPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
