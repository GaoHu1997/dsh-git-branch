/**
 * The one entry point every credential channel goes through (decision 0034).
 *
 * Before this module the store, the `-c http.<url>.extraHeader` injection
 * (`authConfigArgs`, 0021/0029) and the shell environment bridge
 * (`shell-bridge.ts`, 0032/0034) were assembled in three places — the routes,
 * the two model-facing tools and the plugin entry — each resolving the store
 * path itself. Every future plugin that needs git credentials would have
 * repeated that wiring and drifted from it.
 *
 * `createCredentialService` owns the store instance and both injection
 * channels, so callers share one contract:
 *
 *  - {@link CredentialService.authConfigArgs} — the `-c extraHeader` pairs for
 *    git commands the plugin itself runs (panel routes, `git_network`). The
 *    token rides the argv of that one command and never an environment.
 *  - {@link CredentialService.refreshShellEnv} — re-derive the session
 *    gitconfig + `GIT_CONFIG_GLOBAL` environment so a plain shell `git push`
 *    authenticates as configured. Call it after every store change.
 *  - {@link CredentialService.dispose} — undo the environment injection and
 *    delete the session config file (plugin teardown).
 *
 * A store that cannot be read degrades to "no credentials" on every channel
 * (an unauthenticated command runs as it always did; the credentials route is
 * where the file problem surfaces) — a broken file must never break git.
 */

import {
  authConfigArgs,
  createCredentialStore,
  credentialFilePath,
  type CredentialStore,
} from './credentials.js'
import { createShellBridge, type ShellBridgeDeps } from './shell-bridge.js'

/** Host-side seams the service reads through (tests substitute all of them). */
export interface CredentialServiceDeps {
  /** User home directory seam. */
  readonly home: () => string
  /** `$DSH_HOME` seam (blank/undefined = unset). */
  readonly envHome: () => string | undefined
  /** Store seam; the fs-backed store at the resolved path when absent. */
  readonly store?: CredentialStore
  /** The environment object to mutate; `process.env` when absent. */
  readonly env?: Record<string, string | undefined>
  /** Absolute helper script path; the compiled sibling under `helpers/` when absent. */
  readonly helperPath?: string
  /** Node executable that runs the helper; `process.execPath` when absent. */
  readonly nodePath?: string
  /** Directory for the session config; the OS temp dir when absent. */
  readonly configDir?: () => string
  /** Exact session config path (tests); derived from the pid when absent. */
  readonly configPath?: string
  /** User global config the session file includes; `<home>/.gitconfig` when absent. */
  readonly userGitconfig?: string
}

/** The single credential entry point. */
export interface CredentialService {
  /** The shared global store (one row per remote host). */
  readonly store: CredentialStore
  /**
   * `-c http.<url>.extraHeader` pairs for every stored credential, ready to
   * prepend to a git network command the plugin runs itself. A broken store
   * degrades to "no credentials" rather than throwing.
   */
  readonly authConfigArgs: () => Promise<readonly string[]>
  /**
   * Re-derive the shell credential environment after a credential changed, so
   * a message sent in the same session can `git push` with the token the user
   * just saved. Never throws: the worst case is a stale environment until the
   * next refresh.
   */
  readonly refreshShellEnv: () => Promise<void>
  /** Remove the environment injection and delete the session config file. */
  readonly dispose: () => Promise<void>
}

/**
 * Build the credential service for one host process: one store instance, one
 * session-gitconfig bridge, shared by the routes and every tool.
 * @param deps - host seams (see {@link CredentialServiceDeps}).
 */
export function createCredentialService(deps: CredentialServiceDeps): CredentialService {
  const store = deps.store
    ?? createCredentialStore(credentialFilePath(deps.home(), deps.envHome()))
  const bridgeDeps: ShellBridgeDeps = { ...deps, store }
  const shellBridge = createShellBridge(bridgeDeps)
  return {
    store,
    async authConfigArgs(): Promise<readonly string[]> {
      try {
        return authConfigArgs(await store.load())
      } catch {
        return []
      }
    },
    refreshShellEnv(): Promise<void> {
      return shellBridge.apply()
    },
    dispose(): Promise<void> {
      return shellBridge.dispose()
    },
  }
}
