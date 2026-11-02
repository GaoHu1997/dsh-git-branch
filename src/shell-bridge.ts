/**
 * Shell credential bridge (host half) — session gitconfig channel. The
 * credential panel stores one token per remote host, but 0029 could only
 * inject it into the panel's own routes and the `git_network` tool; a plain
 * `git push` run in a shell authenticated as whatever the machine's
 * credential helper held — often a different account — or hung on an
 * interactive prompt nobody could answer.
 *
 * 0032 closed that gap with `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` environment entries. That channel is dead on a DSH
 * host: the subprocess environment scrubber
 * (`@deepseek-ai/dsh-subprocess`, `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`
 * plus every `DSH_*` name) strips the `GIT_CONFIG_KEY_*` names and keeps
 * `GIT_CONFIG_COUNT`/`VALUE_*`, so git starts with a half-parsed config and
 * dies with `fatal: unable to parse command-line config` — every git command
 * in the shell, not only the networked ones (0034).
 *
 * The replacement writes ONE generated gitconfig per host process and points
 * git at it with `GIT_CONFIG_GLOBAL` — a name the scrubber keeps. The file:
 *
 *  1. `[include]`s the user's own `~/.gitconfig` (read-only; 0021's "never
 *     write the user's git config files" stands) so identity, proxies and
 *     `http.sslBackend` keep working;
 *  2. resets the whole `credential.helper` list to empty, cutting the machine
 *     chain (`helper-selector` → GCM) and any helper the included user config
 *     carries (the local `gh` helper being the motivating case);
 *  3. per stored host, resets that URL scope and then installs the bundled
 *     helper (`helpers/git-credential-bridge.js`) as a `!`-shell command.
 *
 * A host with no stored credential then fails at once ("terminal prompts
 * disabled") instead of reaching the machine chain, whose interactive GUI
 * dialog nobody in an agent shell can answer. `GIT_TERMINAL_PROMPT=0` and
 * `GCM_INTERACTIVE=never` ride along as the last line of defence.
 *
 * Environment contract (all names survive the scrubber — no KEY/PASSWORD/
 * SECRET/TOKEN substring, no `DSH_` prefix):
 *  - `GIT_CONFIG_GLOBAL` — the generated session config (0034).
 *  - `DGB_BRIDGE_HELPER` — credential file path for the helper script.
 *  - `GIT_TERMINAL_PROMPT` / `GCM_INTERACTIVE` — fail fast, never prompt.
 *
 * `apply`/`dispose` also delete the retired 0032 channel's leftovers
 * (`GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
 * pairs). The scrubber strips the KEY names while the count and values
 * survive, so a half-injected channel — left behind by an upgrade from
 * 1.0.10 — makes git abort every command; see `legacyConfigNames` (0036).
 *
 * The file is re-derived whenever the credential store changes
 * (`src/routes.ts` calls the bridge after every save / delete / sign-in).
 */

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  credentialFilePath,
  createCredentialStore,
  type CredentialStore,
} from './credentials.js'

/** Env var carrying the credential file path to the helper script. */
export const BRIDGE_HELPER_ENV = 'DGB_BRIDGE_HELPER'

/** Env var carrying a debug log path to the helper script (unset by default). */
export const BRIDGE_DEBUG_ENV = 'DGB_BRIDGE_DEBUG'

/** Env var pointing git at the generated session configuration file. */
export const SESSION_GITCONFIG_ENV = 'GIT_CONFIG_GLOBAL'

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
  /** Directory for the session config; the OS temp dir when absent. */
  readonly configDir?: () => string
  /** Exact session config path (tests); `<configDir>/dsh-git-branch-<pid>.gitconfig` when absent. */
  readonly configPath?: string
  /** User global config the session file includes; `<home>/.gitconfig` when absent. */
  readonly userGitconfig?: string
}

/** The bridge's operations: re-derive the environment, and undo it. */
export interface ShellBridge {
  /** Read the credential store and rewrite the injected environment.
   * A store that cannot be read drops every URL-scoped helper (no host can be
   * bridged), but keeps the global reset, so shell git still fails fast
   * instead of opening an interactive credential dialog. */
  readonly apply: () => Promise<void>
  /** Remove the injected environment and delete the session config file. */
  readonly dispose: () => Promise<void>
  /** The session config path this bridge writes. */
  readonly configPath: () => string
}

/** One ordered environment assignment. */
export type BridgeAssignment = readonly [key: string, value: string]

/**
 * Quote one executable or path for git's `!` shell command. Backslashes are
 * normalized to forward slashes first: git runs `!` helpers through `sh`,
 * where `C:\\…` would be read as escape sequences.
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
 * Escape one value for a gitconfig line: a literal `"` becomes `\"`, which is
 * how a quoted path survives git's config parser and still reaches `sh`
 * intact. Without this the quotes are eaten and `sh` splits
 * `C:/Program Files/…` on the space.
 * @param value - the raw helper command.
 */
export function gitconfigEscape(value: string): string {
  return value.replace(/"/g, '\\"')
}

/**
 * The session gitconfig body for the given hosts: the user's own config
 * included (read-only), the whole machine helper list reset to empty, and per
 * host a URL-scoped reset followed by the bridge command. The empty value
 * before each command is what cuts the included `gh` helper (and any other
 * helper the user configures for that URL) out of that scope.
 * @param hosts - normalized hosts with a stored credential.
 * @param options - the node/helper pair and the user config to include.
 */
export function sessionGitconfigBody(
  hosts: readonly string[],
  options: {
    readonly nodePath: string
    readonly helperPath: string
    readonly userGitconfig?: string
  },
): string {
  const unique = [...new Set(hosts)]
  const lines: string[] = [
    '# Generated by dsh-git-branch-manage (shell credential bridge, decision 0034). Do not edit.',
    '# Regenerated whenever the credential store changes; safe to delete.',
  ]
  if (options.userGitconfig !== undefined) {
    // Read-only include: the user\'s identity, proxies and TLS settings keep
    // working, and nothing is ever written back to this file.
    lines.push('[include]', `\tpath = ${options.userGitconfig.replace(/\\/g, '/')}`)
  }
  // Reset the WHOLE helper list first, even when no host is stored. Without
  // it, any host without a stored credential still reaches the machine chain
  // (`helper-selector` → GCM), which raises a GUI prompt no agent shell can
  // answer. With it, such a host fails at once with "terminal prompts
  // disabled", and the URL-scoped pairs below are the only way credentials
  // get back into a shell.
  lines.push('[credential]', '\thelper =')
  const command = gitconfigEscape(bridgeCommand(options.nodePath, options.helperPath))
  for (const host of unique) {
    lines.push(
      `[credential "https://${host}/"]`,
      // Empty first: it resets whatever helper list the included user config
      // accumulated for this URL (the local `gh` helper), or git would answer
      // with that account before the bridge is ever consulted.
      '\thelper =',
      `\thelper = ${command}`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * The environment assignments pointing git at the session config: the config
 * path itself, the credential file the helper reads, and the two fail-fast
 * switches. `hosts` live in the file now, not in the environment.
 * @param options - the session config path and the credential file.
 */
export function shellBridgeEnv(options: {
  readonly configPath: string
  readonly credentialFile: string
}): readonly BridgeAssignment[] {
  return [
    [SESSION_GITCONFIG_ENV, options.configPath],
    [BRIDGE_HELPER_ENV, options.credentialFile],
    // Fail fast instead of parking a shell on a prompt or a GUI dialog.
    ['GIT_TERMINAL_PROMPT', '0'],
    ['GCM_INTERACTIVE', 'never'],
  ]
}

/** The retired 0032 channel's count variable. */
export const LEGACY_COUNT_ENV = 'GIT_CONFIG_COUNT'

/** Names of the retired 0032 channel's per-entry pairs. */
const LEGACY_KEY_NAME = /^GIT_CONFIG_KEY_\d+$/
const LEGACY_VALUE_NAME = /^GIT_CONFIG_VALUE_\d+$/

/**
 * Environment names left over from the retired 0032 channel that would make
 * git abort with `fatal: unable to parse command-line config`.
 *
 * The DSH subprocess scrubber deletes every `GIT_CONFIG_KEY_<n>` (the name
 * contains `KEY`) while `GIT_CONFIG_COUNT` / `GIT_CONFIG_VALUE_<n>` survive, so
 * the channel is injected half-way and git can no longer parse it. Those
 * leftovers outlive the code that wrote them: upgrading the plugin from 1.0.10
 * leaves them in the host process environment, where they break every `git`
 * command in every derived shell until someone deletes them by hand.
 *
 * A count whose pairs are all present is valid git input (a caller may set the
 * channel deliberately), so it is left untouched; only a broken channel — or a
 * non-numeric count — is reported for removal.
 * @param env - the environment to inspect.
 */
export function legacyConfigNames(env: Record<string, string | undefined>): string[] {
  if (env[LEGACY_COUNT_ENV] === undefined) return []
  const count = Number(env[LEGACY_COUNT_ENV])
  const paired = Number.isInteger(count) && count >= 0
    && Array.from({ length: count }, (_, index) => `GIT_CONFIG_KEY_${index}`)
      .every(name => env[name] !== undefined)
  if (paired) return []
  return Object.keys(env).filter(name =>
    name === LEGACY_COUNT_ENV || LEGACY_KEY_NAME.test(name) || LEGACY_VALUE_NAME.test(name))
}

/**
 * Build the bridge over one host process. Every {@link ShellBridge.apply}
 * rewrites the session config for the current store and re-points the
 * environment at it, so a deleted host loses its helper scope just like a
 * freshly added one gains it. A config file that cannot be written leaves
 * `GIT_CONFIG_GLOBAL` untouched (git then runs with the machine config —
 * unauthenticated at worst) while the fail-fast switches still go out.
 * @param deps - host seams.
 */
export function createShellBridge(deps: ShellBridgeDeps): ShellBridge {
  const env = deps.env ?? process.env
  const configPath = deps.configPath
    ?? join((deps.configDir ?? tmpdir)(), `dsh-git-branch-${String(process.pid)}.gitconfig`)
  let applied: string[] = []
  const credentialFile = (): string => credentialFilePath(deps.home(), deps.envHome())

  /** Delete the retired 0032 channel's leftovers before git can see them. */
  const dropLegacy = (): void => {
    for (const key of legacyConfigNames(env)) {
      delete env[key]
      applied.push(key)
    }
  }

  /** Write the session config atomically with owner-only permissions. */
  const writeConfig = (body: string): void => {
    mkdirSync(dirname(configPath), { recursive: true })
    const partial = `${configPath}.tmp`
    writeFileSync(partial, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(partial, configPath)
    try {
      chmodSync(configPath, 0o600)
    } catch {
      // Best effort: Windows ignores the mode, the file holds no secret.
    }
  }

  return {
    configPath: () => configPath,
    async apply(): Promise<void> {
      let hosts: string[] = []
      try {
        hosts = (await (deps.store ?? createCredentialStore(
          credentialFile(),
        )).load()).map(entry => entry.host)
      } catch {
        // An unreadable store means no host can be bridged. The global helper
        // reset still goes out, so shell git fails fast rather than popping a
        // credential dialog nobody can answer.
        hosts = []
      }
      const helperPath = deps.helperPath
        ?? fileURLToPath(new URL('./helpers/git-credential-bridge.js', import.meta.url))
      const body = sessionGitconfigBody(hosts, {
        nodePath: deps.nodePath ?? process.execPath,
        helperPath,
        userGitconfig: deps.userGitconfig ?? join(deps.home(), '.gitconfig'),
      })
      let assignments: readonly BridgeAssignment[] = [
        ['GIT_TERMINAL_PROMPT', '0'],
        ['GCM_INTERACTIVE', 'never'],
      ]
      try {
        writeConfig(body)
        assignments = shellBridgeEnv({ configPath, credentialFile: credentialFile() })
      } catch {
        // The session config could not be written. Do not point
        // GIT_CONFIG_GLOBAL at a missing file (that would drop the reset and
        // let the machine chain pop a dialog); only the fail-fast switches
        // remain, so a shell git runs unauthenticated but never hangs.
      }
      dropLegacy()
      for (const key of applied) delete env[key]
      applied = []
      for (const [key, value] of assignments) {
        env[key] = value
        applied.push(key)
      }
    },
    async dispose(): Promise<void> {
      dropLegacy()
      for (const key of applied) delete env[key]
      applied = []
      try {
        rmSync(configPath, { force: true })
      } catch {
        // Best effort: a leftover file holds no secret and apply rewrites it.
      }
    },
  }
}
