/**
 * Shell credential setup (host half) — decision 0037.
 *
 * Before 0037 the panel's token only reached commands the plugin itself ran;
 * a plain `git push` in a shell authenticated as whatever the machine's
 * helper held (often a different account) or hung on a prompt nobody could
 * answer. 0032/0034 tried to bridge that through the process environment
 * (`GIT_CONFIG_COUNT`, then a generated `GIT_CONFIG_GLOBAL` session file) —
 * both channels existed only in the host process's own environment, so a
 * shell that received a different environment snapshot saw nothing.
 *
 * 0037 stops fighting the environment and uses git's own mechanisms:
 *
 *  1. `<dsh-home>/git-credentials.include.gitconfig` is generated with one
 *     URL-scoped section per managed host;
 *  2. `~/.gitconfig` gains exactly one `[include] path = <that file>` line
 *     (idempotent; see `ensureGitconfigInclude` in `credentials.ts`);
 *  3. every git process — the plugin's own routes, `git_network`, and a
 *     plain shell — reads that include and therefore resolves the host
 *     through `credential-store`, i.e. `~/.git-credentials`.
 *
 * Nothing rides the process environment any more, which is why the module is
 * now only a gitconfig-install + fail-fast switch manager. `GIT_TERMINAL_PROMPT=0`
 * and `GCM_INTERACTIVE=never` stay: a host without a stored credential should
 * fail at once instead of parking an agent shell on a GUI dialog.
 *
 * `apply`/`dispose` still delete the retired 0032 channel's leftovers
 * (`GIT_CONFIG_COUNT` with a broken `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
 * set). The DSH subprocess scrubber strips the KEY names while the count and
 * values survive, so a half-injected channel — left behind by an upgrade from
 * 1.0.10 — makes git abort every command; see `legacyConfigNames` (0036).
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  credentialIncludeBody,
  credentialIncludeFile,
  createLocalCredentialStore,
  ensureGitconfigInclude,
  removeGitconfigInclude,
  writeFileAtomic,
  type CredentialStore,
} from './credentials.js'

/** Host-side seams the setup reads through (tests substitute all of them). */
export interface ShellBridgeDeps {
  /** User home directory seam. */
  readonly home: () => string
  /** `$DSH_HOME` seam (blank/undefined = unset). */
  readonly envHome: () => string | undefined
  /** Store seam; the fs-backed local store when absent. */
  readonly store?: CredentialStore
  /** The environment object to mutate; `process.env` when absent. */
  readonly env?: Record<string, string | undefined>
  /** User global config the generated file is included from; `<home>/.gitconfig` when absent. */
  readonly userGitconfig?: string
}

/** The setup's operations: re-derive the include, and undo it. */
export interface ShellBridge {
  /** The generated include file (diagnostics/tests). */
  readonly configPath: () => string
  /** Read the credential store and rewrite the include + `~/.gitconfig`.
   * A store that cannot be read writes an empty include (no host is
   * scoped), while the fail-fast switches still go out. */
  readonly apply: () => Promise<void>
  /** Remove the fail-fast switches, the include line and the generated file. */
  readonly dispose: () => Promise<void>
}

/** The retired 0032 channel's count variable. */
export const LEGACY_COUNT_ENV = 'GIT_CONFIG_COUNT'

/** Names of the retired 0032 channel's per-entry pairs. */
const LEGACY_KEY_NAME = /^GIT_CONFIG_KEY_\d+$/
const LEGACY_VALUE_NAME = /^GIT_CONFIG_VALUE_\d+$/

/** Fail fast instead of parking a shell on a prompt or a GUI dialog. */
const FAIL_FAST: ReadonlyArray<readonly [string, string]> = [
  ['GIT_TERMINAL_PROMPT', '0'],
  ['GCM_INTERACTIVE', 'never'],
]

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
 * Build the setup over one host process. Every {@link ShellBridge.apply}
 * rewrites the include for the current store, so a deleted host loses its
 * helper scope just like a freshly added one gains it. A failing write never
 * throws: the worst case is a stale include until the next credential save,
 * and git keeps working with the machine's own configuration.
 * @param deps - host seams.
 */
export function createShellBridge(deps: ShellBridgeDeps): ShellBridge {
  const env = deps.env ?? process.env
  const includePath = credentialIncludeFile(deps.home(), deps.envHome())
  const gitconfig = (): string => deps.userGitconfig ?? join(deps.home(), '.gitconfig')
  const store = (): CredentialStore => deps.store ?? createLocalCredentialStore(deps.home(), deps.envHome())
  let applied: string[] = []

  /** Delete the retired 0032 channel's leftovers before git can see them. */
  const dropLegacy = (): void => {
    for (const key of legacyConfigNames(env)) {
      delete env[key]
      applied.push(key)
    }
  }

  return {
    configPath: () => includePath,
    async apply(): Promise<void> {
      let hosts: string[] = []
      try {
        hosts = (await store().load()).map(entry => entry.host)
      } catch {
        // An unreadable store means no host can be scoped. The include file
        // is still rewritten empty, so a stale host does not keep a helper
        // pointing at a file that no longer holds its credential.
        hosts = []
      }
      try {
        // Write the include first: if `~/.gitconfig` cannot be updated, the
        // file it already points at is at least current.
        await writeFileAtomic(includePath, credentialIncludeBody(hosts), 0o600)
        await ensureGitconfigInclude(gitconfig(), includePath)
      } catch {
        // Deliberately swallowed; see the contract above.
      }
      dropLegacy()
      for (const key of applied) delete env[key]
      applied = []
      for (const [key, value] of FAIL_FAST) {
        env[key] = value
        applied.push(key)
      }
    },
    async dispose(): Promise<void> {
      dropLegacy()
      for (const key of applied) delete env[key]
      applied = []
      try {
        await removeGitconfigInclude(gitconfig(), includePath)
      } catch {
        // Best effort: a leftover include still points at the file below.
      }
      try {
        await rm(includePath, { force: true })
      } catch {
        // Best effort: the file holds no secret and `apply` rewrites it.
      }
    },
  }
}
