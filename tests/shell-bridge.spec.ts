import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { CredentialStore, GitCredential } from '../src/credentials.ts'
import {
  BRIDGE_HELPER_ENV,
  bridgeCommand,
  createShellBridge,
  shellQuote,
  shellBridgeEnv,
} from '../src/shell-bridge.ts'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const HELPER = 'C:\\Users\\u\\.dsh\\profiles\\desktop\\node_modules\\dsh-git-branch-manage\\lib\\helpers\\git-credential-bridge.js'
const FILE = 'C:/Users/u/.dsh/git-credentials.json'

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

/** Ordered assignment lookup, so duplicate keys keep their insertion order. */
function assignmentsOf(assignments: readonly (readonly [string, string])[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const [key, value] of assignments) map.set(key, [...(map.get(key) ?? []), value])
  return map
}

describe('shellQuote', () => {
  it('quotes and normalizes backslashes for git\'s `!` shell', () => {
    expect(shellQuote(NODE)).toBe('"C:/Program Files/nodejs/node.exe"')
    expect(shellQuote('/usr/local/bin/node')).toBe('"/usr/local/bin/node"')
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

describe('shellBridgeEnv', () => {
  it('keeps the fail-fast switches even when no host is stored', () => {
    const map = assignmentsOf(shellBridgeEnv([], { nodePath: NODE, helperPath: HELPER, credentialFile: FILE }))
    // Even with nothing stored, the machine helper chain is cleared: leaving it
    // in place makes git open a GUI prompt no agent shell can answer.
    expect(map.get('GIT_CONFIG_COUNT')).toEqual(['1'])
    expect(map.get('GIT_CONFIG_KEY_0')).toEqual(['credential.helper'])
    expect(map.get('GIT_CONFIG_VALUE_0')).toEqual([''])
    expect(map.get('GIT_TERMINAL_PROMPT')).toEqual(['0'])
    expect(map.get('GCM_INTERACTIVE')).toEqual(['never'])
    expect(map.get(BRIDGE_HELPER_ENV)).toEqual([FILE])
  })

  it('installs a global reset, then an empty reset followed by the bridge command per host', () => {
    const assignments = shellBridgeEnv(['github.com'], { nodePath: NODE, helperPath: HELPER, credentialFile: FILE })
    const map = assignmentsOf(assignments)
    expect(map.get('GIT_CONFIG_COUNT')).toEqual(['3'])
    // Slot 0 clears every helper the machine would otherwise provide.
    expect(map.get('GIT_CONFIG_KEY_0')).toEqual(['credential.helper'])
    expect(map.get('GIT_CONFIG_VALUE_0')).toEqual([''])
    expect(map.get('GIT_CONFIG_KEY_1')).toEqual(['credential.https://github.com/.helper'])
    expect(map.get('GIT_CONFIG_VALUE_1')).toEqual([''])
    expect(map.get('GIT_CONFIG_KEY_2')).toEqual(['credential.https://github.com/.helper'])
    expect(map.get('GIT_CONFIG_VALUE_2')).toEqual([bridgeCommand(NODE, HELPER)])
    // Order matters: the empty value must come first, or git keeps the
    // machine chain and runs it BEFORE the bridge.
    const keys = assignments.map(([key]) => key)
    expect(keys.indexOf('GIT_CONFIG_VALUE_0')).toBeLessThan(keys.indexOf('GIT_CONFIG_VALUE_2'))
    expect(keys.indexOf('GIT_CONFIG_VALUE_1')).toBeLessThan(keys.indexOf('GIT_CONFIG_VALUE_2'))
  })

  it('gives every stored host its own scoped pair', () => {
    const map = assignmentsOf(shellBridgeEnv(['github.com', 'gitee.com'], {
      nodePath: NODE, helperPath: HELPER, credentialFile: FILE,
    }))
    expect(map.get('GIT_CONFIG_COUNT')).toEqual(['5'])
    expect(map.get('GIT_CONFIG_KEY_3')).toEqual(['credential.https://gitee.com/.helper'])
    expect(map.get('GIT_CONFIG_VALUE_4')).toEqual([bridgeCommand(NODE, HELPER)])
  })

  it('collapses duplicate hosts into one pair', () => {
    const map = assignmentsOf(shellBridgeEnv(['github.com', 'github.com'], {
      nodePath: NODE, helperPath: HELPER, credentialFile: FILE,
    }))
    expect(map.get('GIT_CONFIG_COUNT')).toEqual(['3'])
  })
})

describe('createShellBridge', () => {
  const deps = (store: CredentialStore, env: Record<string, string | undefined>) => ({
    home: () => 'C:/Users/u',
    envHome: () => undefined,
    store,
    env,
    helperPath: HELPER,
    nodePath: NODE,
  })

  /** A store whose entries (or load failure) the test can rewrite. */
  function mutableStore(initial: readonly GitCredential[]): CredentialStore & { set: (next: readonly GitCredential[]) => void; break: () => void } {
    let entries = initial
    let broken = false
    return {
      path: FILE,
      load: async () => {
        if (broken) throw new Error('bad file')
        return [...entries]
      },
      save: async () => undefined,
      set: (next) => { entries = next },
      break: () => { broken = true },
    }
  }

  it('writes the environment for the stored hosts', async () => {
    const env: Record<string, string | undefined> = {}
    await createShellBridge(deps(storeOf([credential('github.com')]), env)).apply()
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_2).toBe(bridgeCommand(NODE, HELPER))
    expect(env[BRIDGE_HELPER_ENV]).toBe(join('C:/Users/u', '.dsh', 'git-credentials.json'))
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('drops the assignments of a host that was deleted afterwards', async () => {
    const env: Record<string, string | undefined> = { GIT_CONFIG_PARAMETERS: 'kept' }
    const store = mutableStore([credential('github.com'), credential('gitee.com')])
    const bridge = createShellBridge(deps(store, env))
    await bridge.apply()
    expect(env.GIT_CONFIG_COUNT).toBe('5')
    store.set([credential('github.com')])
    await bridge.apply()
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    // The stale gitee pair must not survive: git would still consult it.
    expect(env.GIT_CONFIG_KEY_3).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_3).toBeUndefined()
    expect(env.GIT_CONFIG_VALUE_4).toBeUndefined()
    // A variable the bridge does not own is left alone.
    expect(env.GIT_CONFIG_PARAMETERS).toBe('kept')
  })

  it('keeps the global helper reset when the store cannot be read', async () => {
    const env: Record<string, string | undefined> = {}
    const store = mutableStore([credential('github.com')])
    const bridge = createShellBridge(deps(store, env))
    await bridge.apply()
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    store.break()
    await bridge.apply()
    // No host can be bridged, but the machine chain stays cleared so nothing
    // pops an interactive credential dialog.
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined()
    expect(env[BRIDGE_HELPER_ENV]).toBe(join('C:/Users/u', '.dsh', 'git-credentials.json'))
  })
})
