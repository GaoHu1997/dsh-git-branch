/**
 * Import the machine's OWN credentials into the managed store (decision 0038).
 *
 * The store itself only knows the lines of `~/.git-credentials`. Everything
 * the user already signed in through — Windows Credential Manager, macOS
 * keychain, `gh auth git-credential` — lives outside that file and cannot be
 * enumerated. What CAN be enumerated is the set of hosts git is configured to
 * talk to (`[credential "https://host"]` sections in the user's gitconfig), so
 * the import probes each of those with `git credential fill` and copies the
 * secret the helper is willing to hand over. A host that answers nothing is
 * reported as failed and left alone: importing never clears, only adds.
 */

import { spawn } from 'node:child_process'
import { TOKEN_USERNAME, normalizeCredentialHost, upsertCredential, type CredentialStore, type GitCredential } from './credentials.js'

/** One host the import copied out of the machine's own helper. */
export interface ImportedCredential {
  host: string
  username: string
  method: 'token' | 'password'
}

/** One host whose helper refused (or could not be asked) — the store is untouched. */
export interface LocalImportFailure {
  host: string
  error: string
}

/** Outcome of one import run. */
export interface LocalImportReport {
  imported: ImportedCredential[]
  skipped: string[]
  failed: LocalImportFailure[]
}

/** One finished git invocation (local import never throws on a non-zero exit). */
export interface LocalGitResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs one git command with `input` on stdin; tests substitute a fake. */
export type LocalGit = (args: readonly string[], input: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<LocalGitResult>

/** Seams for the import: the environment, the git runner, the per-host timeout. */
export interface LocalImportDeps {
  env?: NodeJS.ProcessEnv
  runGit?: LocalGit
  timeoutMs?: number
}

/** A helper may take a while (keychain prompts, network providers); 20s is
 * long enough for a cold GCM start and short enough not to hang a modal. */
const DEFAULT_TIMEOUT_MS = 20_000

/** The production git runner: spawn, feed stdin, collect both streams, kill on
 * the deadline. `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` are applied
 * by the caller, so a missing credential fails instead of opening a dialog. */
export const runGitLocal: LocalGit = (args, input, env, timeoutMs) => new Promise(resolve => {
  const child = spawn('git', [...args], { env, windowsHide: true })
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (result: LocalGitResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(result)
  }
  const timer = setTimeout(() => {
    child.kill()
    finish({ code: -1, stdout, stderr: stderr === '' ? 'git timed out' : stderr })
  }, timeoutMs)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.on('error', error => finish({ code: -1, stdout, stderr: error.message }))
  child.on('close', code => finish({ code: code ?? -1, stdout, stderr }))
  child.stdin.on('error', () => { /* the child may exit before reading stdin */ })
  child.stdin.end(input)
})

/** The local channel: fail fast instead of prompting, and drop any half
 * injected `GIT_CONFIG_COUNT` channel (decision 0036) that would make every
 * git command fail to parse. */
function localEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  for (const key of Object.keys(next)) {
    if (key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete next[key]
  }
  return next
}

/** First non-empty line of a helper's complaint, for the panel. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part !== '')
  return line ?? ''
}

/**
 * Hosts git is configured to ask for credentials: the URL-scoped
 * `[credential "https://host"]` sections of the user's gitconfig, plus any
 * that the global `credential.<url>.helper` keys spell out. Read-only.
 * @param deps - environment and git seams.
 */
export async function localCredentialHosts(deps: LocalImportDeps = {}): Promise<string[]> {
  const run = deps.runGit ?? runGitLocal
  const result = await run(
    ['config', '--get-regexp', '^credential\\.https?://'],
    '',
    localEnv(deps.env ?? process.env),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  // `git config --get-regexp` exits 1 when nothing matches: that is "no
  // candidates", never an error worth surfacing.
  if (result.code !== 0) return []
  const hosts: string[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^credential\.https?:\/\/(\S+?)\.[A-Za-z0-9_-]+(?:\s|$)/i.exec(line)
    if (match === null) continue
    const host = normalizeCredentialHost(match[1] ?? '')
    if (host !== undefined && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/** Ask the machine's own helper for one host's credential. */
async function probe(host: string, deps: LocalImportDeps): Promise<{ username: string; secret: string } | { error: string }> {
  const run = deps.runGit ?? runGitLocal
  const result = await run(
    ['credential', 'fill'],
    `protocol=https\nhost=${host}\n\n`,
    localEnv(deps.env ?? process.env),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  if (result.code !== 0) {
    return { error: firstLine(result.stderr) === '' ? `git exited ${String(result.code)}` : firstLine(result.stderr) }
  }
  const field = (name: string): string => result.stdout.split(/\r?\n/)
    .find(line => line.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? ''
  const secret = field('password')
  if (secret === '') return { error: 'the credential helper returned no secret' }
  return { username: field('username').trim(), secret }
}

/**
 * Copy every host the machine already answers for into the managed store.
 *
 * Candidates come from the caller (`hosts`) or from the user's gitconfig. A
 * host already managed is skipped (the panel is the source of truth for it),
 * a host whose helper answers nothing is reported and left untouched, and the
 * store is written once at the end — a partial import is still a valid import.
 *
 * @param store - the managed credential store.
 * @param deps - environment and git seams.
 * @param hosts - explicit candidates; omitted, the gitconfig's hosts are used.
 */
export async function importLocalCredentials(
  store: CredentialStore,
  deps: LocalImportDeps = {},
  hosts?: readonly string[],
): Promise<LocalImportReport> {
  const report: LocalImportReport = { imported: [], skipped: [], failed: [] }
  const entries = await store.load()
  const managed = new Set(entries.map(entry => entry.host))
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const value of hosts ?? await localCredentialHosts(deps)) {
    const host = normalizeCredentialHost(value)
    if (host === undefined || seen.has(host)) continue
    seen.add(host)
    if (managed.has(host)) {
      report.skipped.push(host)
      continue
    }
    candidates.push(host)
  }
  let next = entries
  for (const host of candidates) {
    const probed = await probe(host, deps)
    if ('error' in probed) {
      report.failed.push({ host, error: probed.error })
      continue
    }
    const token = probed.username === '' || probed.username === TOKEN_USERNAME
    const entry: GitCredential = {
      host,
      username: token ? '' : probed.username,
      secret: probed.secret,
      method: token ? 'token' : 'password',
      updatedAt: Date.now(),
    }
    next = upsertCredential(next, entry)
    report.imported.push({ host, username: token ? TOKEN_USERNAME : probed.username, method: token ? 'token' : 'password' })
  }
  if (report.imported.length > 0) await store.save(next)
  return report
}
