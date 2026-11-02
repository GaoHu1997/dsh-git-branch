/**
 * The one entry point every credential channel goes through (decision 0037).
 *
 * The store is the machine's own `~/.git-credentials` (git's
 * `credential-store` format), plus a secret-free metadata sidecar for the
 * panel's "method / updated" columns. Every channel — the panel routes, both
 * model-facing tools, and a plain `git` command in any shell — authenticates
 * through the same `credential-store` helper, because `createShellBridge`
 * installs a URL-scoped `helper = store` include into `~/.gitconfig`.
 *
 * `createCredentialService` owns the store instance and the include setup, so
 * callers share one contract:
 *
 *  - {@link CredentialService.refreshShellEnv} — re-derive the include after a
 *    store change and run the one-time legacy import. Call it after every save
 *    / delete / sign-in; it never throws.
 *  - {@link CredentialService.dispose} — remove the include line and the
 *    generated file on plugin teardown. The credentials themselves stay in
 *    `~/.git-credentials`: they belong to the user, not to the plugin.
 *
 * A store that cannot be read degrades to "no credentials" on every channel
 * (an unauthenticated command runs as it always did; the credentials route is
 * where the file problem surfaces) — a broken file must never break git.
 */

import {
  createLocalCredentialStore,
  migrateLegacyCredentialFile,
  type CredentialStore,
} from './credentials.js'
import { createShellBridge, type ShellBridgeDeps } from './shell-bridge.js'
import { importLocalCredentials, type LocalImportReport } from './local-import.js'

/** Host-side seams the service reads through (tests substitute all of them). */
export interface CredentialServiceDeps {
  /** User home directory seam. */
  readonly home: () => string
  /** `$DSH_HOME` seam (blank/undefined = unset). */
  readonly envHome: () => string | undefined
  /** Store seam; the fs-backed local store when absent. */
  readonly store?: CredentialStore
  /** The environment object to mutate; `process.env` when absent. */
  readonly env?: Record<string, string | undefined>
  /** User global config the generated include is installed into;
   * `<home>/.gitconfig` when absent. */
  readonly userGitconfig?: string
}

/** The single credential entry point. */
export interface CredentialService {
  /** The shared global store (one row per remote host). */
  readonly store: CredentialStore
  /**
   * Import the retired plugin-private file (once) and re-derive the git
   * include after a credential changed, so a message sent in the same session
   * can `git push` with the token the user just saved. Never throws: the worst
   * case is a stale include until the next refresh.
   */
  readonly refreshShellEnv: () => Promise<void>
  /**
   * Copy the credentials the machine's own helpers already answer for into
   * the store, once per process (decision 0038). Runs on startup so a machine
   * already signed in through gh / GCM / Keychain keeps working without the
   * user re-entering a token here. Idempotent, never throws; the hosts that
   * did import trigger one include refresh.
   */
  readonly autoImport: () => Promise<LocalImportReport>
  /** Remove the fail-fast switches, the include line and the generated file. */
  readonly dispose: () => Promise<void>
}

/**
 * Build the credential service for one host process: one store instance, one
 * gitconfig include, shared by the routes and every tool.
 * @param deps - host seams (see {@link CredentialServiceDeps}).
 */
export function createCredentialService(deps: CredentialServiceDeps): CredentialService {
  const store = deps.store ?? createLocalCredentialStore(deps.home(), deps.envHome())
  const bridgeDeps: ShellBridgeDeps = {
    home: deps.home,
    envHome: deps.envHome,
    store,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.userGitconfig === undefined ? {} : { userGitconfig: deps.userGitconfig }),
  }
  const shellBridge = createShellBridge(bridgeDeps)
  let autoImportTask: Promise<LocalImportReport> | undefined
  return {
    store,
    async refreshShellEnv(): Promise<void> {
      try {
        await migrateLegacyCredentialFile(deps.home(), deps.envHome(), store)
      } catch {
        // A damaged legacy file must not block the include refresh; the
        // credentials route reports it when the user opens the panel.
      }
      await shellBridge.apply()
    },
    autoImport(): Promise<LocalImportReport> {
      autoImportTask ??= (async () => {
        try {
          // The legacy file migrates first so an imported host cannot
          // duplicate a row the panel already had.
          await migrateLegacyCredentialFile(deps.home(), deps.envHome(), store)
        } catch {
          // Same contract as refreshShellEnv: a broken legacy file is not
          // worth failing the startup import over.
        }
        try {
          const report = await importLocalCredentials(store, { env: deps.env ?? process.env })
          if (report.imported.length > 0) await shellBridge.apply()
          return report
        } catch {
          // The import is opportunistic: a missing git, an unreadable store
          // or a helper that misbehaves just leaves the panel as it was.
          return { imported: [], skipped: [], failed: [] }
        }
      })()
      return autoImportTask
    },
    dispose(): Promise<void> {
      return shellBridge.dispose()
    },
  }
}
