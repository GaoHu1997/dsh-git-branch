/**
 * The model-facing `git_network` tool (host half).
 *
 * The credentials panel stores one token per remote host and makes it work on
 * two channels: the panel's own fetch / pull / push routes (`-c
 * http.<url>.extraHeader=…`, see `authConfigArgs`) and the environment bridge
 * the host installs for the shells it spawns (`shell-bridge.ts`). This tool is
 * the third, explicit one: it runs ONE git network command with the same
 * `authConfigArgs` the routes use, so a session reliably pushes as the account
 * the user configured and the secret never enters the conversation — including
 * on a host that predates the bridge.
 *
 * It is deliberately narrower than a shell wrapper: a fixed subcommand
 * allow-list (fetch / pull / push / ls-remote), no force/delete refspecs, no
 * `--upload-pack` / `--receive-pack` / `-c` options, and an absolute
 * `repoPath` as cwd. Those exclusions are about blast radius, not about
 * authentication: the tool exists to let a session reach the network with the
 * configured credential, not to become a general command runner.
 *
 * @module dsh-git-branch/network-tool
 */

import { isAbsolute } from 'node:path'
import {
  authConfigArgs,
  basicUsername,
  createCredentialStore,
  credentialFilePath,
  type CredentialStore,
  type GitCredential,
} from './credentials.js'
import { childProcessExec, NETWORK_TIMEOUT_MS, type Exec } from './git.js'

/** Model-facing tool name. */
export const GIT_NETWORK_TOOL_NAME = 'git_network'

/** The only git subcommands this tool will run. */
export const GIT_NETWORK_SUBCOMMANDS = ['fetch', 'pull', 'push', 'ls-remote'] as const

/** Upper bound on the argument vector (the panel's own commands need far fewer). */
export const GIT_NETWORK_MAX_ARGS = 32

/** Upper bound on one argument token. */
const MAX_TOKEN_LENGTH = 512

/** Output kept from each stream, in characters; git diagnostics are short. */
const MAX_OUTPUT_CHARS = 64 * 1024

/**
 * Global options that would either replace the injected credential, point
 * git at another repository, or load another config. They belong BEFORE the
 * subcommand in git's own grammar, so the allow-list below already rejects
 * them; this set is defence in depth for arguments passed after it.
 */
const BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--bare',
  '--no-replace-objects',
])

/** Same defence for flags that take a value with `=`. */
const BLOCKED_PREFIXES: readonly string[] = ['--config-env=', '--upload-pack', '--receive-pack', '--exec=']

/** `push` is the one subcommand where these change the remote irreversibly. */
const PUSH_BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  '-f',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '-d',
  '--prune',
])

/** The arguments this tool accepts. */
export interface GitNetworkArgs {
  /** Absolute directory inside the target repository; the command's cwd. */
  readonly repoPath?: string
  /** Git arguments, subcommand first (`['push', 'origin', 'main']`). */
  readonly args?: readonly string[]
}

/** A validated request, ready to run. */
export interface GitNetworkRequest {
  readonly repoPath: string
  readonly args: readonly string[]
}

/** The canonical value `execute` returns. */
export interface GitNetworkValue {
  /** Directory the command ran in (echoed for the transcript). */
  readonly repoPath: string
  /** The git subcommand that ran. */
  readonly subcommand: string
  /** git's exit status; a non-zero status is a normal result, not an error. */
  readonly exitCode: number
  /** Standard output, secret-redacted and length-capped. */
  readonly stdout: string
  /** Standard error, secret-redacted and length-capped. */
  readonly stderr: string
  /** Hosts a credential was injected for (injected in full on every call). */
  readonly authenticatedHosts: readonly string[]
  /** Whether either stream was cut at the length cap. */
  readonly truncated: boolean
  /** Why the credential store could not be read; the command then ran bare. */
  readonly credentialsError?: string
}

/** Host-side seams the tool reads through. */
export interface GitNetworkToolDeps {
  /** User home directory seam. */
  readonly home: () => string
  /** `$DSH_HOME` seam (blank/undefined = unset). */
  readonly envHome: () => string | undefined
  /** Store seam; the fs-backed store at the resolved path when absent. */
  readonly store?: CredentialStore
  /** Process seam; the real `git` over node:child_process when absent. */
  readonly exec?: Exec
}

/** A tool definition as `ctx.tools.register` accepts it. */
export interface GitNetworkTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: GitNetworkArgs, value: GitNetworkValue) => readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly execute: (args: GitNetworkArgs, exec?: { readonly signal?: AbortSignal }) => Promise<GitNetworkValue>
}

/**
 * Why a request cannot run (undefined = fine). Pure and exhaustive so the
 * tests can pin every rejection without spawning git.
 * @param repoPath - the requested cwd (validated as an absolute path).
 * @param args - the requested git argument vector (subcommand first).
 */
export function gitNetworkRequestIssue(repoPath: unknown, args: unknown): string | undefined {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') return '"repoPath" must be a non-empty string'
  if (!isAbsolute(repoPath)) return '"repoPath" must be an absolute path'
  if (!Array.isArray(args) || args.length === 0) return '"args" must be a non-empty array of git arguments'
  if (args.length > GIT_NETWORK_MAX_ARGS) return `"args" may hold at most ${String(GIT_NETWORK_MAX_ARGS)} items`

  const tokens: string[] = []
  for (const item of args) {
    if (typeof item !== 'string') return '"args" must contain only strings'
    if (item === '' || item.includes('\0')) return '"args" must not contain empty or NUL tokens'
    if (item.length > MAX_TOKEN_LENGTH) return `one argument exceeds ${String(MAX_TOKEN_LENGTH)} characters`
    tokens.push(item)
  }

  const subcommand = tokens[0]
  if (subcommand === undefined) return '"args" must name a git subcommand first'
  if (!(GIT_NETWORK_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return `"${subcommand}" is not permitted here; use one of ${GIT_NETWORK_SUBCOMMANDS.join(', ')}`
  }

  for (const token of tokens.slice(1)) {
    if (BLOCKED_FLAGS.has(token)) return `"${token}" is not permitted by this tool`
    const blocked = BLOCKED_PREFIXES.find(prefix => token.startsWith(prefix))
    if (blocked !== undefined) return `"${blocked}…" is not permitted by this tool`
    if (subcommand === 'push') {
      if (PUSH_BLOCKED_FLAGS.has(token)) return `"${token}" is not permitted: this tool never forces or deletes on the remote`
      if (token.startsWith('+') || token.startsWith(':')) {
        return 'force/delete refspecs ("+" or ":") are not permitted: this tool never forces or deletes on the remote'
      }
    }
  }
  return undefined
}

/** Validate one raw request or throw the reason as a plain Error. */
function requestOf(args: GitNetworkArgs): GitNetworkRequest {
  const issue = gitNetworkRequestIssue(args.repoPath, args.args)
  if (issue !== undefined) throw new Error(issue)
  return { repoPath: args.repoPath as string, args: [...(args.args as readonly string[])] }
}

/** Cut one stream at the cap; `truncated` reports whether anything was lost. */
function cap(text: string): { readonly text: string; readonly truncated: boolean } {
  return text.length <= MAX_OUTPUT_CHARS
    ? { text, truncated: false }
    : { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
}

/**
 * Remove stored secrets — raw and in the Basic header's base64 form — from
 * git's own diagnostics. git does not echo the Authorization header, but the
 * redaction also covers a remote URL that embeds the token, and costs one
 * pass per stored host.
 * @param text - one captured stream.
 * @param entries - the credentials that were injected.
 */
export function redactSecrets(text: string, entries: readonly GitCredential[]): string {
  let out = text
  for (const entry of entries) {
    if (entry.secret !== '') out = out.split(entry.secret).join('****')
    const basic = Buffer.from(`${basicUsername(entry)}:${entry.secret}`, 'utf8').toString('base64')
    out = out.split(basic).join('****')
  }
  return out
}

/** Compose the model-facing text of one result. */
export function renderGitNetwork(value: GitNetworkValue): string {
  const hosts = value.authenticatedHosts.length === 0 ? 'none' : value.authenticatedHosts.join(', ')
  const lines = [
    `git ${value.subcommand} (exit ${String(value.exitCode)}) in ${value.repoPath}`,
    `credentials injected for: ${hosts}`,
  ]
  if (value.credentialsError !== undefined) lines.push(`credentials unavailable: ${value.credentialsError}`)
  if (value.stdout.trim() !== '') lines.push('--- stdout ---', value.stdout.trimEnd())
  if (value.stderr.trim() !== '') lines.push('--- stderr ---', value.stderr.trimEnd())
  if (value.truncated) lines.push('(output truncated at the length cap)')
  return lines.join('\n')
}

/**
 * Build the `git_network` tool definition.
 * @param deps - host seams (home/env, an optional store and an optional exec).
 * @returns a definition ready for `ctx.tools.register`.
 */
export function gitNetworkTool(deps: GitNetworkToolDeps): GitNetworkTool {
  const storeOf = (): CredentialStore =>
    deps.store ?? createCredentialStore(credentialFilePath(deps.home(), deps.envHome()))
  const exec = deps.exec ?? childProcessExec

  return {
    name: GIT_NETWORK_TOOL_NAME,
    description: 'Run ONE git network command (fetch, pull, push or ls-remote) inside a repository with the '
      + 'plugin\'s stored Git credentials injected, so the command authenticates as the account configured in the '
      + 'Git credential panel instead of whatever the machine\'s git credential helper happens to hold. Prefer it for '
      + 'every push/fetch/pull: the credential is injected explicitly and redacted from the output, while a plain '
      + 'shell `git push` only reaches these credentials through the environment bridge the plugin host installs '
      + 'for the shells it spawns. That bridge is absent in an older host or in a terminal started outside it; there '
      + 'git clears the machine helper chain too, so an unconfigured host fails fast with a "terminal prompts '
      + 'disabled" error instead of opening a credential dialog nobody can answer. Pass the git '
      + 'arguments subcommand-first, for example ["push"], ["fetch", "--all", "--prune"] or '
      + '["push", "origin", "main"]. Force/delete refspecs, --force/--delete/--mirror/--prune and '
      + '--upload-pack/--receive-pack style options are rejected by design. The secret itself never appears in the '
      + 'result: only exit status, redacted stdout/stderr and the hosts that were authenticated.',
    parameters: {
      type: 'object',
      properties: {
        repoPath: {
          type: 'string',
          description: 'Absolute path to any directory inside the target repository; the command runs with this as cwd.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Git arguments with the subcommand first. Permitted subcommands: fetch, pull, push, ls-remote.',
        },
      },
      required: ['repoPath', 'args'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          subcommand: { type: 'string' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          authenticatedHosts: { type: 'array', items: { type: 'string' } },
          truncated: { type: 'boolean' },
          credentialsError: { type: 'string' },
        },
        required: ['repoPath', 'subcommand', 'exitCode', 'stdout', 'stderr', 'authenticatedHosts', 'truncated'],
      },
      render: (_args: GitNetworkArgs, value: GitNetworkValue) => [
        { type: 'text', text: renderGitNetwork(value) },
      ],
    },
    async execute(raw: GitNetworkArgs): Promise<GitNetworkValue> {
      const request = requestOf(raw ?? {})
      let entries: GitCredential[] = []
      let credentialsError: string | undefined
      try {
        entries = await storeOf().load()
      } catch (error) {
        // A damaged credential file must not make the tool unusable: run the
        // command bare and report why, exactly like the routes do.
        credentialsError = error instanceof Error ? error.message : String(error)
      }

      const hosts = [...new Set(entries.map(entry => entry.host))].sort()
      const result = await exec('git', [...authConfigArgs(entries), ...request.args], {
        cwd: request.repoPath,
        timeoutMs: NETWORK_TIMEOUT_MS,
      })
      const stdout = cap(redactSecrets(result.stdout, entries))
      const stderrSource = result.stderr.trim() === '' && result.errorMessage !== undefined
        ? result.errorMessage
        : result.stderr
      const stderr = cap(redactSecrets(stderrSource, entries))
      return {
        repoPath: request.repoPath,
        subcommand: request.args[0] ?? '',
        exitCode: result.code,
        stdout: stdout.text,
        stderr: stderr.text,
        authenticatedHosts: hosts,
        truncated: stdout.truncated || stderr.truncated,
        ...(credentialsError === undefined ? {} : { credentialsError }),
      }
    },
  }
}
