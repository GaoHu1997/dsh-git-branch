/**
 * Global git credential store (host half), backed by the machine's own
 * credential file (decision 0037).
 *
 * A credential belongs to a remote HOST, not to a project: the same
 * `github.com` token serves every repository. Up to 1.1.x the plugin kept its
 * own `~/.dsh/git-credentials.json`, which meant the panel's token was
 * invisible to a plain `git` run in a shell and the machine's helpers
 * answered instead (often with a different account). 0037 makes the panel
 * manage the SAME file git's built-in `credential-store` helper uses —
 * `~/.git-credentials` — so one save is visible to every git process:
 *
 *  - the secret lines are the store format (`https://user:pass@host`),
 *    percent-encoded exactly as `git credential approve` writes them;
 *  - method/updatedAt cannot live in that format, so a sibling
 *    `<dsh-home>/git-credentials.meta.json` keeps the UI-only metadata
 *    (no secret ever goes in there);
 *  - a generated `<dsh-home>/git-credentials.include.gitconfig` scopes
 *    `helper = store` to each managed host, and `~/.gitconfig` gains one
 *    `[include] path = <that file>` line (idempotent, decision 0037
 *    overturns 0021's "never write the user's git config" for exactly this
 *    one scoped include).
 *
 * The secret never travels to the browser — the list route answers masked
 * tails only — and only `https://` remotes are ever covered.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './settings.js'
import type { CredentialMethod } from './wire.js'

/**
 * The Basic-auth name git sends when a token was stored without a username.
 * GitHub, GitLab and Gitee all accept any non-empty name for a personal access
 * token, and `oauth2` is the conventional placeholder. The store format has no
 * "blank username", so this value is what a blank one becomes on disk and is
 * read back as blank again.
 */
export const TOKEN_USERNAME = 'oauth2'

/** One stored credential: exactly one per remote host. */
export interface GitCredential {
  /** Normalized remote host (`github.com`, `git.example.com:8443`). */
  host: string
  /** Basic-auth username (a real account name, or a vendor-form placeholder
   * such as `x-access-token` / `oauth2`). Blank for a bare token. */
  username: string
  /** Token or password, verbatim (never returned to the client). */
  secret: string
  /** How the secret is meant to be used — informational for the UI; git
   * itself only sees the Basic header. */
  method: CredentialMethod
  /** Epoch millis of the last save (0 when unknown). */
  updatedAt: number
}

/** Load/save seam for the credential file (tests substitute an in-memory one). */
export interface CredentialStore {
  /** Absolute file the store persists secrets to (for diagnostics/UI hints). */
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
 * The retired 0021/0029 plugin-private file `<dsh-home>/git-credentials.json`.
 * Read once by {@link migrateLegacyCredentialFile} and deleted afterwards.
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` environment value seam (blank = unset).
 */
export function credentialFilePath(home: string, envHome: string | undefined): string {
  return join(resolveDshHome(home, envHome), 'git-credentials.json')
}

/**
 * `~/.git-credentials` — the file git's `credential-store` helper reads and
 * writes (`$HOME/.git-credentials` on every platform).
 * @param home - user home directory seam.
 */
export function gitCredentialsFile(home: string): string {
  return join(home, '.git-credentials')
}

/**
 * The UI-only metadata sidecar: method and `updatedAt` per host. Never holds a
 * secret; a missing or damaged file only costs the "how/when" columns.
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` environment value seam.
 */
export function credentialMetaFile(home: string, envHome: string | undefined): string {
  return join(resolveDshHome(home, envHome), 'git-credentials.meta.json')
}

/**
 * The generated gitconfig included from `~/.gitconfig`: one URL-scoped
 * `helper = store` section per managed host.
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` environment value seam.
 */
export function credentialIncludeFile(home: string, envHome: string | undefined): string {
  return join(resolveDshHome(home, envHome), 'git-credentials.include.gitconfig')
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

/**
 * Percent-encode one userinfo component the way git's store helper does:
 * everything outside the RFC 3986 unreserved set becomes `%xx` (lowercase
 * hex, matching `git credential approve`). `encodeURIComponent` would leave
 * `!'()*` alone and git would then mis-split the line at a literal `@`.
 * @param value - raw username or secret.
 */
export function encodeCredentialPart(value: string): string {
  let encoded = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte)
    encoded += /[A-Za-z0-9\-._~]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0')}`
  }
  return encoded
}

/**
 * One `<scheme>://user:pass@host` line, ready for `~/.git-credentials`.
 * @param entry - the credential to write.
 */
export function formatCredentialLine(entry: GitCredential): string {
  return `https://${encodeCredentialPart(basicUsername(entry))}:${encodeCredentialPart(entry.secret)}@${entry.host}`
}

/** A `~/.git-credentials` file split into credentials and untouched lines. */
export interface ParsedCredentials {
  /** One credential per https host; a duplicated host keeps the LAST line,
   * which is the line git's store helper would resolve to after a rewrite. */
  readonly entries: GitCredential[]
  /** Lines this store does not own (comments, ssh/http rows, malformed
   * text). Written back verbatim so a hand-edited file survives a save. */
  readonly others: string[]
}

/**
 * Parse one `~/.git-credentials` line. Anything that is not an `https://`
 * URL with a password is not ours (the store helper would not authenticate
 * with it either).
 * @param line - one non-empty line, already trimmed.
 */
function parseCredentialLine(line: string): GitCredential | undefined {
  let url: URL
  try {
    url = new URL(line)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  if (url.password === '') return undefined
  const host = normalizeCredentialHost(url.host)
  if (host === undefined) return undefined
  let username = url.username
  let secret = url.password
  try {
    username = decodeURIComponent(username)
  } catch {
    // Keep the raw text; a literal `%` is legal in a username.
  }
  try {
    secret = decodeURIComponent(secret)
  } catch {
    // Same for the secret.
  }
  if (username === TOKEN_USERNAME) username = ''
  return {
    host,
    username,
    secret,
    method: username === '' ? 'token' : 'password',
    updatedAt: 0,
  }
}

/**
 * Parse a `~/.git-credentials` document.
 * @param text - raw file contents (BOM tolerated).
 */
export function parseGitCredentials(text: string): ParsedCredentials {
  const byHost = new Map<string, GitCredential>()
  const others: string[] = []
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const entry = parseCredentialLine(raw.trim())
    if (entry === undefined) {
      others.push(raw)
      continue
    }
    byHost.set(entry.host, entry)
  }
  return { entries: sortCredentials([...byHost.values()]), others }
}

/** The retired JSON document shape (read only, for the 0037 migration). */
interface CredentialFile {
  version: 1
  credentials: GitCredential[]
}

/**
 * Parse the retired `<dsh-home>/git-credentials.json`. Unknown extra fields
 * are tolerated (a hand-edited file), but a malformed entry is an error rather
 * than a silent drop — losing a credential during the one-time migration is
 * worse than an explicit message.
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

/** The metadata sidecar document: no secret, only display facts. */
interface CredentialMetaFile {
  version: 1
  credentials: Array<{ host: string; method: CredentialMethod; updatedAt: number }>
}

/**
 * Read the metadata sidecar. A missing, empty or damaged file reads as "no
 * metadata": the credentials themselves still load, only the method/age
 * columns fall back to their inferred values.
 * @param path - absolute meta file path.
 */
async function readCredentialMeta(path: string): Promise<Map<string, { method: CredentialMethod; updatedAt: number }>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return new Map()
  }
  if (text.trim() === '') return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new Map()
  }
  const raw = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>).credentials
    : undefined
  if (!Array.isArray(raw)) return new Map()
  const byHost = new Map<string, { method: CredentialMethod; updatedAt: number }>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const host = typeof record.host === 'string' ? normalizeCredentialHost(record.host) : undefined
    const method = record.method
    if (host === undefined || (method !== 'token' && method !== 'password')) continue
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    byHost.set(host, { method, updatedAt })
  }
  return byHost
}

/** Serialize the metadata sidecar. */
function serializeCredentialMeta(entries: readonly GitCredential[]): string {
  const document: CredentialMetaFile = {
    version: 1,
    credentials: sortCredentials(entries).map(entry => ({
      host: entry.host,
      method: entry.method,
      updatedAt: entry.updatedAt,
    })),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Write-then-rename so a crashed save never truncates the real file. */
export async function writeFileAtomic(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`
  try {
    await writeFile(temp, text, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Read a text file, treating "missing" as empty. */
async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new CredentialStoreError(path, `could not be read (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * The real store over `~/.git-credentials`. The secret lines are the git
 * store format; the sibling metadata file carries method/updatedAt only.
 * A missing file reads as "no credentials yet".
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` environment value seam.
 */
export function createLocalCredentialStore(home: string, envHome: string | undefined): CredentialStore {
  const path = gitCredentialsFile(home)
  const metaPath = credentialMetaFile(home, envHome)
  return {
    path,
    load: async (): Promise<GitCredential[]> => {
      const { entries } = parseGitCredentials(await readTextOrEmpty(path))
      const meta = await readCredentialMeta(metaPath)
      return entries.map(entry => {
        const extra = meta.get(entry.host)
        return extra === undefined ? entry : { ...entry, method: extra.method, updatedAt: extra.updatedAt }
      })
    },
    save: async (entries: readonly GitCredential[]): Promise<void> => {
      // Keep the lines we do not own (ssh/http rows, comments) so a save
      // never rewrites somebody else's credential file.
      const { others } = parseGitCredentials(await readTextOrEmpty(path))
      const lines = [...others, ...sortCredentials(entries).map(formatCredentialLine)]
      try {
        await writeFileAtomic(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 0o600)
        await writeFileAtomic(metaPath, serializeCredentialMeta(entries), 0o600)
      } catch (error) {
        throw new CredentialStoreError(path, `could not be written (${error instanceof Error ? error.message : String(error)})`)
      }
    },
  }
}

/**
 * One-time 0037 migration: import the retired plugin-private JSON into the
 * local store (plugin values win for a host they share), then delete the old
 * file so there is exactly one place a secret lives.
 *
 * Idempotent: a missing legacy file is a no-op, and the file is removed only
 * after the store write succeeded — a failed migration keeps the old file.
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` environment value seam.
 * @param store - destination store.
 * @returns true when a legacy file was imported and removed.
 */
export async function migrateLegacyCredentialFile(
  home: string,
  envHome: string | undefined,
  store: CredentialStore,
): Promise<boolean> {
  const legacy = credentialFilePath(home, envHome)
  let text: string
  try {
    text = await readFile(legacy, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new CredentialStoreError(legacy, `could not be read (${error instanceof Error ? error.message : String(error)})`)
  }
  const imported = text.trim() === '' ? [] : parseCredentialFile(text, legacy)
  if (imported.length > 0) {
    const current = await store.load()
    const merged = imported.reduce((entries, entry) => upsertCredential(entries, entry), current)
    await store.save(merged)
  }
  await rm(legacy, { force: true })
  return true
}

/**
 * The generated include file's contents: one URL-scoped section per host that
 * resets any inherited helper for that exact URL and then installs the
 * built-in `store` helper. The empty `helper =` line is what beats a
 * user-level helper (`gh`, GCM) configured for the same host.
 * @param hosts - managed remote hosts (already normalized).
 */
export function credentialIncludeBody(hosts: readonly string[]): string {
  const lines = [
    '# Generated by dsh-git-branch (decision 0037). Do not edit:',
    '# every credential save rewrites this file.',
  ]
  for (const host of [...new Set(hosts)].sort()) {
    lines.push('', `[credential "https://${host}/"]`, '\thelper =', '\thelper = store')
  }
  return `${lines.join('\n')}\n`
}

/** Compare two config paths the way git resolves them (case-insensitive on
 * Windows in practice; slashes and surrounding quotes normalized here). */
function normalizeConfigPath(value: string): string {
  return value
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Whether `~/.gitconfig` already includes the generated file. Matched loosely
 * (any `path = <X>` line pointing at it) so a hand-reformatted include — or
 * one with forward slashes on Windows — is not added a second time.
 * @param text - current `~/.gitconfig` contents.
 * @param includePath - the generated file.
 */
export function gitconfigHasInclude(text: string, includePath: string): boolean {
  const wanted = normalizeConfigPath(includePath)
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*path\s*=\s*(.*)$/i.exec(line)
    if (match !== null && normalizeConfigPath(match[1] ?? '') === wanted) return true
  }
  return false
}

/**
 * Append the `[include] path = …` section, leaving every existing byte alone.
 * @param text - current `~/.gitconfig` contents.
 * @param includePath - the generated file.
 */
export function appendGitconfigInclude(text: string, includePath: string): string {
  const body = `[include]\n\tpath = ${includePath.replace(/\\/g, '/')}\n`
  if (text.trim() === '') return body
  return text.endsWith('\n') ? `${text}${body}` : `${text}\n${body}`
}

/**
 * Idempotently ensure `~/.gitconfig` includes the generated file. Rewrites
 * atomically, preserving the file's existing mode; a missing file is created.
 * @param gitconfigPath - user global config (`<home>/.gitconfig`).
 * @param includePath - the generated file.
 * @returns true when the file had to be changed.
 */
export async function ensureGitconfigInclude(gitconfigPath: string, includePath: string): Promise<boolean> {
  let text = ''
  let mode: number | undefined
  try {
    text = await readFile(gitconfigPath, 'utf8')
    mode = (await stat(gitconfigPath)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (gitconfigHasInclude(text, includePath)) return false
  await writeFileAtomic(gitconfigPath, appendGitconfigInclude(text, includePath), mode)
  return true
}

/**
 * Remove the include section pointing at the generated file (plugin teardown).
 * Every other line is preserved verbatim.
 * @param text - current `~/.gitconfig` contents.
 * @param includePath - the generated file.
 */
export function stripGitconfigInclude(text: string, includePath: string): string {
  const wanted = normalizeConfigPath(includePath)
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^\s*\[include\]\s*$/i.test(line)) {
      let end = index + 1
      let matched = false
      while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) {
        const match = /^\s*path\s*=\s*(.*)$/i.exec(lines[end] ?? '')
        if (match !== null && normalizeConfigPath(match[1] ?? '') === wanted) matched = true
        end += 1
      }
      if (matched) {
        index = end - 1
        continue
      }
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Remove the generated include from `~/.gitconfig`. Best effort: a teardown
 * must not throw, and an already-clean file is left untouched.
 * @param gitconfigPath - user global config (`<home>/.gitconfig`).
 * @param includePath - the generated file.
 */
export async function removeGitconfigInclude(gitconfigPath: string, includePath: string): Promise<void> {
  let text: string
  let mode: number | undefined
  try {
    text = await readFile(gitconfigPath, 'utf8')
    mode = (await stat(gitconfigPath)).mode & 0o777
  } catch {
    return
  }
  if (!gitconfigHasInclude(text, includePath)) return
  await writeFileAtomic(gitconfigPath, stripGitconfigInclude(text, includePath), mode)
}
