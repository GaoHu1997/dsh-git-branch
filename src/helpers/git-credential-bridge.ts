/**
 * Standalone git credential helper shipped with the dsh-git-branch plugin.
 *
 * The panel's credential file (`~/.dsh/git-credentials.json`) normally rides
 * `-c http.<url>.extraHeader` config on the routes and the `git_network` tool.
 * This helper extends that coverage to a plain shell `git push`: the plugin's
 * host process exports `GIT_CONFIG_COUNT/KEY/VALUE` entries that install this
 * script as a URL-scoped credential helper for every stored host, so commands
 * the model runs in the shell authenticate as the configured account too.
 *
 * Design constraints (see docs/decisions/0029 and 0032):
 *  - The user's global git config and credential helpers are never written;
 *    the injection lives in the process environment only.
 *  - The token never enters the conversation: this script reads the
 *    credential file directly on the host and answers git on stdout.
 *  - URL scope (`credential.https://<host>/.helper`) confines the helper to
 *    hosts with a stored credential. The host half also clears the machine
 *    helper list, so a host this script cannot answer fails fast instead of
 *    opening an interactive credential dialog.
 *  - `get` is silent on a miss (git falls through to the next helper);
 *    `store`/`erase` are pass-through by decision — writing back would race
 *    the panel's atomic save and leak the file shape.
 *
 * Environment contract (set by src/shell-bridge.ts):
 *  - `DSH_GIT_BRIDGE_HELPER` — credential file path (required).
 *  - `DSH_GIT_BRIDGE_HOME` — user home directory (fallback resolution).
 *  - `DSH_GIT_BRIDGE_DSH_HOME` — `$DSH_HOME` override (optional).
 *  - `DSH_GIT_BRIDGE_DEBUG` — when non-blank, a debug log path (optional).
 *
 * @module dsh-git-branch/git-credential-bridge
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** git helpers receive exactly one argument: the operation. */
const OPERATION = process.argv[2] ?? 'get'

/** The credential file this helper reads (`DSH_GIT_BRIDGE_HELPER` wins). */
const DEFAULT_CREDENTIAL_FILE = 'git-credentials.json'

/** The dsh home directory below the user profile when `$DSH_HOME` is unset. */
const PACKAGE_HOME = '.dsh'

/** The Basic-auth name a token without a username is sent under. */
const TOKEN_USERNAME = 'oauth2'

/**
 * Append one debug line behind the user's back; a broken log path must never
 * break the credential lookup.
 */
function debug(line: string): void {
  const path = process.env.DSH_GIT_BRIDGE_DEBUG
  if (path === undefined || path.trim() === '') return
  try {
    appendFileSync(path, `${line}\n`, 'utf8')
  } catch {
    // Deliberately swallowed: debugging is best-effort.
  }
}

/** The credential file this helper reads (`DSH_GIT_BRIDGE_HELPER` wins). */
function credentialFile(): string {
  const helper = process.env.DSH_GIT_BRIDGE_HELPER
  if (helper !== undefined && helper.trim() !== '') return helper
  const dshHome = process.env.DSH_GIT_BRIDGE_DSH_HOME
  const home = dshHome !== undefined && dshHome.trim() !== ''
    ? dshHome
    : process.env.DSH_GIT_BRIDGE_HOME ?? homedir()
  return join(home, DEFAULT_CREDENTIAL_FILE)
}

/** One `key=value` request from git on stdin. */
function readRequest(): Map<string, string> {
  const text = readFileSync(0, 'utf8')
  const request = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) request.set(line.slice(0, at), line.slice(at + 1))
  }
  return request
}

/** The stored credential for one host, or undefined when there is none. */
function readCredential(host: string): { username: string; secret: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(credentialFile(), 'utf8'))
  } catch (error) {
    debug(`read failed: ${String(error)}`)
    return undefined
  }
  const credentials = (parsed as { credentials?: unknown }).credentials
  if (!Array.isArray(credentials)) return undefined
  const entry = credentials.find(
    (item): item is { username?: unknown; secret?: unknown } =>
      typeof item === 'object' && item !== null && (item as { host?: unknown }).host === host,
  )
  if (entry === undefined) return undefined
  const secret = typeof entry.secret === 'string' ? entry.secret : ''
  if (secret === '') return undefined
  const username = typeof entry.username === 'string' && entry.username.trim() !== ''
    ? entry.username
    : TOKEN_USERNAME
  return { username, secret }
}

if (OPERATION === 'get') {
  const request = readRequest()
  const host = request.get('host') ?? ''
  debug(`get host=${host} protocol=${request.get('protocol') ?? ''}`)
  const credential = readCredential(host)
  if (credential !== undefined) {
    process.stdout.write(`username=${credential.username}\npassword=${credential.secret}\n`)
  }
  // A miss stays silent: git tries the next helper in the chain.
}
// `store` / `erase` are deliberate no-ops (see the header comment).
