/**
 * Global git credential store (host half). Credentials belong to a remote
 * HOST, not to a project: the same `github.com` token serves every repository
 * the panel touches, so the record lives in one file under `$DSH_HOME`
 * (`~/.dsh`) instead of the per-repository settings document. The secret
 * never travels to the browser — the list route answers masked tails only —
 * and the store is read/written by the host alone.
 *
 * Authentication rides `git -c http.https://<host>/.extraHeader=…` on the
 * panel's own network commands and on the `git_network` tool: the user's git
 * configuration FILES are never written. Plain `git` commands in a spawned
 * shell are covered separately by the environment bridge in `shell-bridge.ts`,
 * which installs this store's per-host tokens as URL-scoped credential helpers
 * through `GIT_CONFIG_*` (process environment only, never a config file).
 * Only `https://` remotes receive the header; ssh and plain-http remotes are
 * never sent a secret.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './settings.js'
import type { CredentialMethod } from './wire.js'

/**
 * The Basic-auth name git sends when a token was stored without a username.
 * GitHub, GitLab and Gitee all accept any non-empty name for a personal access
 * token, and `oauth2` is the conventional placeholder.
 */
export const TOKEN_USERNAME = 'oauth2'

/** One stored credential: exactly one per remote host. */
export interface GitCredential {
  /** Normalized remote host (`github.com`, `git.example.com:8443`). */
  host: string
  /** Basic-auth username (a real account name, or a vendor-form placeholder
   * such as `x-access-token` / `oauth2`). */
  username: string
  /** Token or password, verbatim (never returned to the client). */
  secret: string
  /** How the secret is meant to be used — informational for the UI; git
   * itself only sees the Basic header. */
  method: CredentialMethod
  /** Epoch millis of the last save. */
  updatedAt: number
}

/** Load/save seam for the credential file (tests substitute an in-memory one). */
export interface CredentialStore {
  /** Absolute file the store persists to (for diagnostics/UI hints). */
  readonly path: string
  /** Every stored credential, one per host, sorted by host. A missing file
   * is the empty list; an unreadable/malformed one throws
   * {@link CredentialStoreError}. */
  load: () => Promise<GitCredential[]>
  /** Replace the whole set atomically (temp file + rename). */
  save: (entries: readonly GitCredential[]) => Promise<void>
}

/** A credential file the store could not read or understand. */
export class CredentialStoreError extends Error {
  constructor(readonly path: string, message: string) {
    super(`credential file "${path}" ${message}`)
    this.name = 'CredentialStoreError'
  }
}

/**
 * Resolve the credential file location: `<dsh-home>/git-credentials.json`.
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` environment value seam (blank = unset).
 */
export function credentialFilePath(home: string, envHome: string | undefined): string {
  return join(resolveDshHome(home, envHome), 'git-credentials.json')
}

/** Why a user-typed host is not usable yet (undefined = fine). */
export type CredentialHostIssue = 'empty' | 'invalid'

/**
 * Normalize a remote host typed or pasted by the user. Accepts a bare host
 * (`github.com`), a host with a port (`git.example.com:8443`), a full remote
 * URL (`https://github.com/org/repo.git`), an scp-like remote
 * (`git@github.com:org/repo.git`) and a URL with userinfo — the host is the
 * only part the credential needs. Lowercased, no scheme, path, userinfo or
 * trailing slash.
 * @param value - raw draft text.
 * @returns the normalized host, or undefined when nothing usable is left.
 */
export function normalizeCredentialHost(value: string): string | undefined {
  let host = value.trim().toLowerCase()
  // Scheme (`https://`) and everything after the authority (`/org/repo`).
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const slash = host.search(/[/?#]/)
  if (slash >= 0) host = host.slice(0, slash)
  // Userinfo (`user:pass@host`); scp-like `git@host:path` keeps the host part.
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  // scp-like `host:path` — keep the host before the colon, unless the colon
  // introduces a numeric port.
  const colon = host.indexOf(':')
  if (colon >= 0 && !/^\d{1,5}$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host === '') return undefined
  // Hostname (single-label intranet hosts allowed) with an optional port.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/.test(host)) return undefined
  return host
}

/**
 * Pre-flight check of a user-typed credential host.
 * @param value - raw draft text.
 */
export function credentialHostIssue(value: string): CredentialHostIssue | undefined {
  if (value.trim() === '') return 'empty'
  return normalizeCredentialHost(value) === undefined ? 'invalid' : undefined
}

/**
 * Why a username is not usable yet (undefined = fine). A token credential may
 * leave the username empty: vendors accept any non-empty Basic-auth name
 * alongside a personal access token, so only password mode requires one.
 * @param value - raw draft text.
 * @param method - the method the draft targets (defaults to password mode).
 */
export function credentialUsernameIssue(
  value: string,
  method: CredentialMethod = 'password',
): 'empty' | 'illegal' | undefined {
  if (value.trim() === '') return method === 'token' ? undefined : 'empty'
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'illegal'
  return undefined
}

/**
 * The Basic-auth username git actually sends for one entry.
 * @param entry - the stored credential.
 * @returns the stored username, or {@link TOKEN_USERNAME} for a token saved
 * without one.
 */
export function basicUsername(entry: GitCredential): string {
  return entry.username.trim() === '' ? TOKEN_USERNAME : entry.username
}

/** Why a secret is not usable yet (undefined = fine). */
export function credentialSecretIssue(value: string): 'empty' | 'illegal' | undefined {
  if (value.trim() === '') return 'empty'
  // A pasted multi-line blob (or a stray control character) would corrupt
  // the Basic header; interior spaces stay legal — passwords may carry them.
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'illegal'
  return undefined
}

/**
 * Mask a stored secret for the list route: the tail only, never the value.
 * @param secret - the stored secret.
 */
export function maskSecret(secret: string): string {
  const tail = secret.slice(-4)
  return secret.length <= 4 ? '****' : `****${tail}`
}

/**
 * The git config argv that authenticates network commands against the stored
 * hosts: one `http.<https-url>.extraHeader` per host. Git applies a
 * `http.<url>.*` section only to a matching remote URL, so injecting every
 * stored host at once cannot leak one host's header to another; only
 * `https://` URLs match (ssh/http never receive it).
 * @param entries - stored credentials (duplicates collapsed by host).
 * @returns the `-c <key>=<value>` pairs, ready to prepend to a subcommand.
 */
export function authConfigArgs(entries: readonly GitCredential[]): readonly string[] {
  // Collapse duplicates by host, LAST entry winning: a hand-edited file with
  // two rows for one host must hand git the row the list route shows last.
  const byHost = new Map<string, GitCredential>()
  for (const entry of entries) byHost.set(entry.host, entry)
  const args: string[] = []
  for (const entry of byHost.values()) {
    const basic = Buffer.from(`${basicUsername(entry)}:${entry.secret}`, 'utf8').toString('base64')
    args.push('-c', `http.https://${entry.host}/.extraHeader=AUTHORIZATION: basic ${basic}`)
  }
  return args
}

/**
 * Insert or update one credential; the pair `(host, updatedAt)` changes,
 * everything else is replaced. An existing host keeps its position.
 * @param entries - current credentials.
 * @param next - the entry to store (host already normalized).
 * @returns a NEW sorted array.
 */
export function upsertCredential(entries: readonly GitCredential[], next: GitCredential): GitCredential[] {
  const rest = entries.filter(entry => entry.host !== next.host)
  return sortCredentials([...rest, next])
}

/**
 * Drop one host's credential.
 * @param entries - current credentials.
 * @param host - normalized host to forget.
 * @returns a NEW sorted array.
 */
export function removeCredential(entries: readonly GitCredential[], host: string): GitCredential[] {
  return entries.filter(entry => entry.host !== host)
}

/** Stable host order for the file and the UI. */
export function sortCredentials(entries: readonly GitCredential[]): GitCredential[] {
  return [...entries].sort((left, right) => left.host.localeCompare(right.host))
}

/** The persisted document shape (versioned so a future migration can detect it). */
interface CredentialFile {
  version: 1
  credentials: GitCredential[]
}

/**
 * Parse the credential file. Unknown extra fields are tolerated (a
 * hand-edited file), but a malformed entry is an error rather than a silent
 * drop — losing a credential behind the user's back is worse than an
 * explicit message. Hosts are re-normalized and de-duplicated.
 * @param text - raw file contents.
 * @param path - file path (for the error message).
 */
export function parseCredentialFile(text: string, path = 'git-credentials.json'): GitCredential[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CredentialStoreError(path, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialStoreError(path, 'must contain a JSON object')
  }
  const raw = (parsed as Record<string, unknown>).credentials
  if (!Array.isArray(raw)) throw new CredentialStoreError(path, 'has no "credentials" array')
  const byHost = new Map<string, GitCredential>()
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new CredentialStoreError(path, `entry #${String(index + 1)} is not an object`)
    }
    const record = item as Record<string, unknown>
    const host = typeof record.host === 'string' ? normalizeCredentialHost(record.host) : undefined
    const username = typeof record.username === 'string' ? record.username : undefined
    const secret = typeof record.secret === 'string' ? record.secret : undefined
    const method = record.method
    if (host === undefined || username === undefined || secret === undefined || (method !== 'token' && method !== 'password')) {
      throw new CredentialStoreError(path, `entry #${String(index + 1)} is missing a valid host/username/secret/method`)
    }
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    byHost.set(host, { host, username, secret, method, updatedAt })
  }
  return sortCredentials([...byHost.values()])
}

/**
 * Serialize the credential set for the file.
 * @param entries - stored credentials.
 */
export function serializeCredentialFile(entries: readonly GitCredential[]): string {
  const document: CredentialFile = { version: 1, credentials: sortCredentials(entries) }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * The real file-backed store: atomic replace, `0600` where the platform
 * honours it. A missing file reads as "no credentials yet".
 * @param path - absolute credential file path.
 */
export function createCredentialStore(path: string): CredentialStore {
  return {
    path,
    load: async (): Promise<GitCredential[]> => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new CredentialStoreError(path, `could not be read (${error instanceof Error ? error.message : String(error)})`)
      }
      if (text.trim() === '') return []
      return parseCredentialFile(text, path)
    },
    save: async (entries: readonly GitCredential[]): Promise<void> => {
      const directory = dirname(path)
      await mkdir(directory, { recursive: true })
      // Write-then-rename keeps a crashed save from truncating the real file.
      const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`
      try {
        await writeFile(temp, serializeCredentialFile(entries), { encoding: 'utf8', mode: 0o600 })
        await rename(temp, path)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw new CredentialStoreError(path, `could not be written (${error instanceof Error ? error.message : String(error)})`)
      }
    },
  }
}
