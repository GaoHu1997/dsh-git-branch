/**
 * The model-facing `git_credentials` tool (host half).
 *
 * The credential file is global, so a session that pushes to a new host often
 * needs to know which hosts are already configured before asking the user to
 * paste a token again. Hence one read-only tool over the same store the routes
 * use: it lists hosts, methods and masked secrets, and never writes.
 *
 * Nothing here imports `@deepseek-ai/dsh-tools`: a plain definition object
 * registered through `ctx.tools.register` is the documented path for a plugin
 * that must not take a value dependency on the host runtime. The registry
 * validates `output.schema` and passes model arguments through verbatim, so
 * this module validates its own arguments.
 *
 * @module dsh-git-branch/tool
 */

import {
  basicUsername,
  createCredentialStore,
  credentialFilePath,
  maskSecret,
  type CredentialStore,
  type GitCredential,
} from './credentials.js'

/** Model-facing tool name. */
export const GIT_CREDENTIALS_TOOL_NAME = 'git_credentials'

/** One text block in a tool result. */
export interface ToolTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** The arguments this tool accepts. */
export interface GitCredentialsArgs {
  /** Restrict the listing to one host (`github.com`); omitted lists all. */
  readonly host?: string
  /** Return stored secrets verbatim instead of masking them. */
  readonly includeSecret?: boolean
}

/** One credential row as the model sees it. */
export interface GitCredentialsRow {
  readonly host: string
  readonly username: string
  readonly method: string
  /** Masked tail, or the secret verbatim when `includeSecret` was set. */
  readonly secret: string
  /** ISO-8601 timestamp of the last save (empty when unknown). */
  readonly updatedAt: string
}

/** The canonical value `execute` returns. */
export interface GitCredentialsValue {
  /** Absolute credential file the rows come from. */
  readonly path: string
  /** Total number of configured hosts, before `host` filtering. */
  readonly total: number
  /** The rows, sorted by host. */
  readonly credentials: readonly GitCredentialsRow[]
  /** Why the store could not be read; rows are then empty. */
  readonly error?: string
}

/** Host-side seams the tool reads through. */
export interface GitCredentialsToolDeps {
  /** User home directory seam. */
  readonly home: () => string
  /** `$DSH_HOME` seam (blank/undefined = unset). */
  readonly envHome: () => string | undefined
  /** Store seam; the fs-backed store at the resolved path when absent. */
  readonly store?: CredentialStore
}

/** A tool definition as `ctx.tools.register` accepts it. */
export interface GitCredentialsTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: GitCredentialsArgs, value: GitCredentialsValue) => readonly ToolTextBlock[]
  }
  readonly execute: (args: GitCredentialsArgs, exec?: { readonly signal?: AbortSignal }) => Promise<GitCredentialsValue>
}

/** Project one stored entry onto its model-facing row. */
function credentialRow(entry: GitCredential, includeSecret: boolean): GitCredentialsRow {
  return {
    host: entry.host,
    username: entry.username === '' ? basicUsername(entry) : entry.username,
    method: entry.method,
    secret: includeSecret ? entry.secret : maskSecret(entry.secret),
    updatedAt: entry.updatedAt > 0 ? new Date(entry.updatedAt).toISOString() : '',
  }
}

/** Compose the model-facing text of one result. */
export function renderGitCredentials(value: GitCredentialsValue): string {
  if (value.error !== undefined) return `git credentials are unavailable: ${value.error}`
  const head = `${String(value.total)} configured host${value.total === 1 ? '' : 's'} (${value.path})`
  if (value.credentials.length === 0) return `${head}\n(no matching credential)`
  const rows = value.credentials.map((row) => {
    const parts = [row.host, row.method, `user ${row.username}`, row.secret]
    if (row.updatedAt !== '') parts.push(`saved ${row.updatedAt}`)
    return `- ${parts.join(' · ')}`
  })
  return [head, ...rows].join('\n')
}

/**
 * Build the `git_credentials` tool definition.
 * @param deps - host seams (home/env and an optional store override).
 * @returns a definition ready for `ctx.tools.register`.
 */
export function gitCredentialsTool(deps: GitCredentialsToolDeps): GitCredentialsTool {
  const storeOf = (): CredentialStore => deps.store ?? createCredentialStore(credentialFilePath(deps.home(), deps.envHome()))

  /** Read the store, folding a read failure into the result value. */
  const read = async (args: GitCredentialsArgs): Promise<GitCredentialsValue> => {
    const store = storeOf()
    if (args.host !== undefined && typeof args.host !== 'string') {
      throw new Error('invalid host: expected a string')
    }
    if (args.includeSecret !== undefined && typeof args.includeSecret !== 'boolean') {
      throw new Error('invalid includeSecret: expected a boolean')
    }
    const wanted = args.host?.trim().toLowerCase()
    const includeSecret = args.includeSecret === true
    try {
      const entries = await store.load()
      const rows = entries
        .filter(entry => wanted === undefined || wanted === '' || entry.host === wanted)
        .map(entry => credentialRow(entry, includeSecret))
      return { path: store.path, total: entries.length, credentials: rows }
    } catch (error) {
      return {
        path: store.path,
        total: 0,
        credentials: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    name: GIT_CREDENTIALS_TOOL_NAME,
    description: 'List the Git credentials this machine stores for remote hosts (GitHub, GitLab, Gitee, ...). '
      + 'The store is global per host and the git-worktree plugin injects it automatically into its fetch, '
      + 'update, push and tag-push commands, so a configured host needs no further setup. Secrets are masked; '
      + 'pass includeSecret only when the user explicitly asked to see the stored token, because the value then '
      + 'appears in the conversation transcript.',
    parameters: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Only list this host, for example "github.com". Omit to list every configured host.',
        },
        includeSecret: {
          type: 'boolean',
          description: 'Return the stored secret verbatim instead of a masked tail. Only set this when the user '
            + 'explicitly asked to see the secret.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          total: { type: 'integer' },
          credentials: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                host: { type: 'string' },
                username: { type: 'string' },
                method: { type: 'string' },
                secret: { type: 'string' },
                updatedAt: { type: 'string' },
              },
              required: ['host', 'username', 'method', 'secret', 'updatedAt'],
            },
          },
          error: { type: 'string' },
        },
        required: ['path', 'total', 'credentials'],
      },
      render: (_args: GitCredentialsArgs, value: GitCredentialsValue) => [
        { type: 'text', text: renderGitCredentials(value) },
      ],
    },
    async execute(args: GitCredentialsArgs): Promise<GitCredentialsValue> {
      return read(args ?? {})
    },
  }
}
