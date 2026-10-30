/**
 * Shell credential bridge (host half). The credential panel stores one token
 * per remote host, but 0029 could only inject it into the panel's own routes
 * and the `git_network` tool; a plain `git push` run in a shell authenticated
 * as whatever the machine's credential helper held — often a different
 * account — or hung on an interactive prompt nobody could answer.
 *
 * This module closes that gap without touching the user's git configuration
 * FILES (0021's constraint): it exports `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` entries that install the bundled credential helper
 * (`helpers/git-credential-bridge.js`) as a URL-scoped helper for every stored
 * host. git reads that environment as configuration, every child process the
 * host spawns inherits it, and a non-empty value list is always preceded by the
 * same key with an empty value — git resets the accumulated helper list
 * there, so the machine chain (`helper-selector` → GCM) can neither answer
 * with a different account nor open a blocking dialog for those hosts.
 * The list is reset globally as well: a host with no stored credential then
 * fails at once ("terminal prompts disabled") instead of reaching the machine
 * chain, whose interactive GUI dialog nobody in an agent shell can answer.
 *
 * `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` ride along so a host
 * with no usable credential fails fast instead of parking a shell on a prompt
 * (the failure mode that started this: a 3m38s silent hang).
 *
 * The assignments are re-derived whenever the credential store changes
 * (`src/routes.ts` calls the bridge after every save / delete / sign-in).
 */

import { fileURLToPath } from 'node:url'
import {
  credentialFilePath,
  createCredentialStore,
  type CredentialStore,
} from './credentials.js'

/** Env var carrying the credential file path to the helper script. */
export const BRIDGE_HELPER_ENV = 'DSH_GIT_BRIDGE_HELPER'

/** Env var carrying a debug log path to the helper script (unset by default). */
export const BRIDGE_DEBUG_ENV = 'DSH_GIT_BRIDGE_DEBUG'

/** Host-side seams the bridge reads through (tests substitute all of them). */
export interface ShellBridgeDeps {
  /** User home directory seam. */
  readonly home: () => string
  /** `$DSH_HOME` seam (blank/undefined = unset). */
  readonly envHome: () => string | undefined
  /** Store seam; the fs-backed store at the resolved path when absent. */
  readonly store?: CredentialStore
  /** The environment object to mutate; `process.env` when absent. */
  readonly env?: Record<string, string | undefined>
  /** Absolute helper script path; the compiled sibling under `helpers/` when
   * absent. */
  readonly helperPath?: string
  /** Node executable that runs the helper; `process.execPath` when absent. */
  readonly nodePath?: string
}

/** The bridge's one operation: re-derive the environment from the store. */
export interface ShellBridge {
  /** Read the credential store and rewrite the injected environment.
   * A store that cannot be read drops every URL-scoped helper (no host can be
   * bridged), but keeps the global reset, so shell git still fails fast
   * instead of opening an interactive credential dialog. */
  readonly apply: () => Promise<void>
}

/** One ordered environment assignment. */
export type BridgeAssignment = readonly [key: string, value: string]

/**
 * Quote one executable or path for git's `!` shell command. Backslashes are
 * normalized to forward slashes first: git runs `!` helpers through `sh`,
 * where `C:\…` would be read as escape sequences.
 * @param value - an absolute path.
 */
export function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, '/')}"`
}

/**
 * The helper command git runs for one configured host: a `!`-prefixed shell
 * command, because git does not word-split a helper value by itself (a bare
 * `node "C:/…/bridge.js"` is looked up as the program `git-credential-node`).
 * @param nodePath - the node executable.
 * @param helperPath - the compiled helper script.
 */
export function bridgeCommand(nodePath: string, helperPath: string): string {
  return `!${shellQuote(nodePath)} ${shellQuote(helperPath)}`
}

/**
 * The ordered environment assignments for the given hosts: per host an empty
 * helper value (git resets the accumulated list for that URL scope) and then
 * the bridge command, plus the credential-file variable the helper reads and
 * the two fail-fast switches.
 * @param hosts - normalized hosts with a stored credential.
 * @param options - process paths and the credential file.
 */
export function shellBridgeEnv(
  hosts: readonly string[],
  options: {
    readonly nodePath: string
    readonly helperPath: string
    readonly credentialFile: string
  },
): readonly BridgeAssignment[] {
  const unique = [...new Set(hosts)]
  const assignments: BridgeAssignment[] = []
  // Reset the WHOLE helper list first, even when no host is stored. Without it,
  // any host without a stored credential still reaches the machine chain
  // (`helper-selector` → GCM), which raises a GUI prompt no agent shell can
  // answer — the dialog that kept popping up. With it, such a host fails at
  // once with "terminal prompts disabled", and the URL-scoped pairs below are
  // the only way credentials get back into a shell.
  assignments.push(['GIT_CONFIG_COUNT', String(unique.length * 2 + 1)])
  assignments.push(['GIT_CONFIG_KEY_0', 'credential.helper'], ['GIT_CONFIG_VALUE_0', ''])
  unique.forEach((host, index) => {
    const key = `credential.https://${host}/.helper`
    const empty = String(index * 2 + 1)
    const command = String(index * 2 + 2)
    assignments.push([`GIT_CONFIG_KEY_${empty}`, key], [`GIT_CONFIG_VALUE_${empty}`, ''])
    assignments.push([`GIT_CONFIG_KEY_${command}`, key], [`GIT_CONFIG_VALUE_${command}`, bridgeCommand(options.nodePath, options.helperPath)])
  })
  assignments.push([BRIDGE_HELPER_ENV, options.credentialFile])
  // Fail fast instead of parking a shell on a prompt or a GUI dialog.
  assignments.push(['GIT_TERMINAL_PROMPT', '0'], ['GCM_INTERACTIVE', 'never'])
  return assignments
}

/**
 * Build the bridge over one host process. Every {@link ShellBridge.apply}
 * first removes the assignments it made last time, so a deleted host loses
 * its helper scope just like a freshly added one gains it.
 * @param deps - host seams.
 */
export function createShellBridge(deps: ShellBridgeDeps): ShellBridge {
  const env = deps.env ?? process.env
  let applied: string[] = []

  return {
    async apply(): Promise<void> {
      let hosts: string[] = []
      try {
        hosts = (await (deps.store ?? createCredentialStore(
          credentialFilePath(deps.home(), deps.envHome()),
        )).load()).map(entry => entry.host)
      } catch {
        // An unreadable store means no host can be bridged. The global helper
        // reset still goes out, so shell git fails fast rather than popping a
        // credential dialog nobody can answer.
        hosts = []
      }
      const helperPath = deps.helperPath
        ?? fileURLToPath(new URL('./helpers/git-credential-bridge.js', import.meta.url))
      const assignments = shellBridgeEnv(hosts, {
        nodePath: deps.nodePath ?? process.execPath,
        helperPath,
        credentialFile: credentialFilePath(deps.home(), deps.envHome()),
      })
      for (const key of applied) delete env[key]
      applied = []
      for (const [key, value] of assignments) {
        env[key] = value
        applied.push(key)
      }
    },
  }
}
