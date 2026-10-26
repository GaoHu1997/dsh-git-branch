/**
 * dsh-git-branch host half. Exposes volatile configuration fields projected
 * through the settings service (the `git-worktree` profile entry in the active
 * dsh profile) and — while a webServer service exists — the HTTP routes the
 * browser half fetches. Config edits persist into the profile patch and take
 * effect live via the loader.
 */

import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context declaration merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the settings Context declaration merge (`ctx.settings`).
import type {} from '@deepseek-ai/dsh-settings'
import { childProcessExec } from './git.js'
import { ACCEL_DEFAULT_URL, accelerateUrlError } from './normalize.js'
import {
  handleAiCommitMessage, handleChanges, handleCommit, handleCommitFiles, handleCreateBranch, handleCreateWorktree, handleDeleteBranch, handleEnsureDirectory, handleFetch, handleGroupWorktrees, handleInspectWorktree, handleLog, handlePathExists, handlePurgeDirectory, handleRemoveWorktree, handleRenameBranch, handleStage, handleStatus, handleSwitch, handleUpdate, handlePush, handleWorktreesAll,
  type LlmStreamRuntime, type RouteDeps, type RouteOutcome,
} from './routes.js'
import { validateRootDir } from './settings.js'
import { ROUTE_AI_COMMIT_MESSAGE, ROUTE_BRANCH, ROUTE_BRANCH_DELETE, ROUTE_BRANCH_RENAME, ROUTE_CHANGES, ROUTE_COMMIT, ROUTE_COMMIT_FILES, ROUTE_ENSURE_DIRECTORY, ROUTE_EXISTS, ROUTE_FETCH, ROUTE_GROUP, ROUTE_INSPECT, ROUTE_LOG, ROUTE_PUSH, ROUTE_PURGE, ROUTE_REMOVE, ROUTE_STAGE, ROUTE_STATUS, ROUTE_SWITCH, ROUTE_UPDATE, ROUTE_WORKTREE, ROUTE_WORKTREES_ALL } from './wire.js'

export const name = 'dsh-git-branch'

export const inject = []

/** Largest accepted request body (bytes) — these payloads are a few strings. */
const BODY_LIMIT = 64 * 1024

function readVolatile<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && 'get' in value && typeof (value as { get: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

export interface Config {
  /** Worktree storage root; defaults to `$DSH_HOME/gitworktree` (`~/.dsh/gitworktree`). */
  rootDir?: Volatile<string | undefined> | string
  /** Sidebar git grouping on/off; absent = on (the composition-entry layer's default). */
  groupSidebar?: Volatile<boolean> | boolean
  /** Fetch every remote before creating a worktree; absent = off. A failed
   * fetch never blocks the creation (see the /worktree route). */
  fetchBeforeCreate?: Volatile<boolean> | boolean
  /** Prune stale worktrees lazily after each creation; absent = off. */
  autoPruneWorktrees?: Volatile<boolean> | boolean
  /** Global cap the lazy prune trims down to (valid git worktrees only);
   * absent = 30. */
  keepWorktrees?: Volatile<number> | number
  /** Post-create configuration files to copy when .worktreeinclude is absent;
   * absent = none. */
  postCreateCopyFiles?: Volatile<string[]> | string[]
  /** cn-accelerate mirror rewrite for network READ commands (fetch/update);
   * absent = off. PUSH is never rewritten. */
  cnAccelerate?: Volatile<boolean> | boolean
  /** cn-accelerate mirror prefix; absent = the shipped default. */
  cnAccelerateUrl?: Volatile<string> | string
}

/** The shipped prune cap (whole storage root, valid git worktrees only). */
export const KEEP_WORKTREES_DEFAULT = 30

/**
 * Cordis resolves the composition entry's config through this schema before
 * `apply` runs. In dsh 0.1.7+, fields marked with `.volatile()` are projected
 * by the settings service into live configuration forms.
 */
export const Config: z = z.object({
  rootDir: z.string().volatile(),
  groupSidebar: z.boolean().default(true).volatile(),
  fetchBeforeCreate: z.boolean().default(false).volatile(),
  autoPruneWorktrees: z.boolean().default(false).volatile(),
  keepWorktrees: z.number().default(KEEP_WORKTREES_DEFAULT).volatile(),
  postCreateCopyFiles: z.array(z.string()).default([]).volatile(),
  cnAccelerate: z.boolean().default(false).volatile(),
  cnAccelerateUrl: z.string().default(ACCEL_DEFAULT_URL).volatile(),
})

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const unknown = Object.keys(config).find(key =>
    key !== 'rootDir' && key !== 'groupSidebar' && key !== 'fetchBeforeCreate' && key !== 'autoPruneWorktrees' && key !== 'keepWorktrees' && key !== 'postCreateCopyFiles' && key !== 'cnAccelerate' && key !== 'cnAccelerateUrl')
  if (unknown !== undefined) {
    throw new Error(`GitWorktreeConfig: unknown key "${unknown}"`)
  }
  const root = readVolatile(config.rootDir)
  if (root !== undefined && (typeof root !== 'string' || root.length === 0)) {
    throw new Error('GitWorktreeConfig: "rootDir" must be a non-empty string')
  }
  const groupSidebar = readVolatile(config.groupSidebar)
  if (groupSidebar !== undefined && typeof groupSidebar !== 'boolean') {
    throw new Error('GitWorktreeConfig: "groupSidebar" must be a boolean')
  }
  const fetchBeforeCreate = readVolatile(config.fetchBeforeCreate)
  if (fetchBeforeCreate !== undefined && typeof fetchBeforeCreate !== 'boolean') {
    throw new Error('GitWorktreeConfig: "fetchBeforeCreate" must be a boolean')
  }
  const autoPruneWorktrees = readVolatile(config.autoPruneWorktrees)
  if (autoPruneWorktrees !== undefined && typeof autoPruneWorktrees !== 'boolean') {
    throw new Error('GitWorktreeConfig: "autoPruneWorktrees" must be a boolean')
  }
  const postCreateCopyFiles = readVolatile(config.postCreateCopyFiles)
  if (postCreateCopyFiles !== undefined) {
    if (!Array.isArray(postCreateCopyFiles) || !postCreateCopyFiles.every(item => typeof item === 'string')) {
      throw new Error('GitWorktreeConfig: "postCreateCopyFiles" must be an array of strings')
    }
  }
  const cnAccelerate = readVolatile(config.cnAccelerate)
  if (cnAccelerate !== undefined && typeof cnAccelerate !== 'boolean') {
    throw new Error('GitWorktreeConfig: "cnAccelerate" must be a boolean')
  }
  validateCnAccelerateUrl(readVolatile(config.cnAccelerateUrl))
  validateKeepWorktrees(readVolatile(config.keepWorktrees))
  validateRootDir(root)
}

/**
 * The accelerate prefix must be an http(s) URL without whitespace — it is
 * concatenated with `https://github.com/` into one `url.<base>.insteadOf`
 * config value, so a space would smuggle arguments and a non-http scheme is
 * not a fetchable remote. Absent = the shipped default, which passes.
 */
export function validateCnAccelerateUrl(value: string | undefined): void {
  if (value === undefined) return
  if (typeof value !== 'string' || accelerateUrlError(value) !== undefined) {
    throw new Error('GitWorktreeConfig: "cnAccelerateUrl" must be an http(s) URL without whitespace')
  }
}

/**
 * The prune cap must be an integer >= 1: 0 would read as "create then
 * immediately self-delete" (the fresh worktree is excluded, but every other
 * one dies on the next creation), a fraction cannot count directories.
 * Absent = the shipped default, which passes.
 */
export function validateKeepWorktrees(value: number | undefined): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('GitWorktreeConfig: "keepWorktrees" must be an integer >= 1')
  }
}

/** The settings namespace this plugin serves; its browser card spells the same string. */
export const GIT_WORKTREE_NS = 'git-worktree'

/** The settings-facing subset of the config: the worktree storage root, the
 * sidebar grouping switch, and the create/prune behavior switches. */
export interface SectionConfig {
  /** Worktree storage root; absent/blank selects `$DSH_HOME/gitworktree`. */
  rootDir?: string
  /** Whether the sidebar groups same-repository workspaces; absent = on. */
  groupSidebar?: boolean
  /** Fetch every remote before creating a worktree; absent = off. */
  fetchBeforeCreate?: boolean
  /** Prune stale worktrees lazily after each creation; absent = off. */
  autoPruneWorktrees?: boolean
  /** Global cap the lazy prune trims down to; absent = 30. */
  keepWorktrees?: number
  /** Post-create configuration files to copy when .worktreeinclude is absent. */
  postCreateCopyFiles?: string[]
  /** cn-accelerate mirror rewrite for network READ commands; absent = off. */
  cnAccelerate?: boolean
  /** cn-accelerate mirror prefix; absent = the shipped default. */
  cnAccelerateUrl?: string
}


/** The section-shaped view of a config: absent keys stay absent
 * (`exactOptionalPropertyTypes`) except the switches, which spell their
 * shipped defaults so a user-layer unset can always fall back to them. */
export function sectionOf(config: Config): SectionConfig {
  const rootDir = readVolatile(config.rootDir)
  const postCreateCopyFiles = readVolatile(config.postCreateCopyFiles)
  const groupSidebar = readVolatile(config.groupSidebar)
  const fetchBeforeCreate = readVolatile(config.fetchBeforeCreate)
  const autoPruneWorktrees = readVolatile(config.autoPruneWorktrees)
  const keepWorktrees = readVolatile(config.keepWorktrees)
  const cnAccelerate = readVolatile(config.cnAccelerate)
  const cnAccelerateUrl = readVolatile(config.cnAccelerateUrl)
  return {
    ...(rootDir === undefined ? {} : { rootDir }),
    ...(postCreateCopyFiles === undefined ? {} : { postCreateCopyFiles }),
    ...(cnAccelerateUrl === undefined ? {} : { cnAccelerateUrl }),
    // The composition layer spells the shipped defaults so a user-layer
    // unset can always fall back to them.
    groupSidebar: groupSidebar ?? true,
    fetchBeforeCreate: fetchBeforeCreate ?? false,
    autoPruneWorktrees: autoPruneWorktrees ?? false,
    cnAccelerate: cnAccelerate ?? false,
    keepWorktrees: keepWorktrees ?? KEEP_WORKTREES_DEFAULT,
  }
}

/**
 * Plugin apply: mount the settings presentation policy and HTTP routes on any
 * webServer that comes and goes.
 * @param ctx - host cordis context.
 * @param config - the composition entry config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateConfig(config)

  const currentConfig = (): Config => (ctx.fiber?.config as Config | undefined) ?? config

  const deps = (): RouteDeps => ({
    exec: childProcessExec,
    sectionRootDir: () => readVolatile(currentConfig().rootDir),
    sectionFetchBeforeCreate: () => readVolatile(currentConfig().fetchBeforeCreate),
    sectionPostCreateCopyFiles: () => readVolatile(currentConfig().postCreateCopyFiles),
    sectionCnAccelerate: () => readVolatile(currentConfig().cnAccelerate),
    sectionCnAccelerateUrl: () => readVolatile(currentConfig().cnAccelerateUrl),
    home: () => homedir(),
    envHome: () => process.env.DSH_HOME,
  })

  // In dsh 0.1.7+, the settings service projects volatile Config fields into forms.
  // We configure auto: false to inform the host that this plugin provides its own
  // dedicated configuration card (via `plugins.bundle.config`).
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'git-worktree: settings presentation policy')
  })

  ctx.inject(['webServer'], (webCtx) => {
    /** Send one outcome as JSON; no-store because repo facts are point-in-time. */
    const send = (res: ServerResponse, outcome: RouteOutcome): void => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(outcome.body))
    }

    /** Read and JSON-parse one bounded request body. */
    const readJson = (req: IncomingMessage): Promise<unknown> => new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          req.destroy()
          rejectPromise(new Error('request body too large'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) {
          resolvePromise({})
          return
        }
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          rejectPromise(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      req.on('error', rejectPromise)
    })

    /** One exact POST route: bounded JSON body in, one RouteOutcome out. A
     * body-level failure (too large, invalid JSON) answers 400 and leaves
     * the server alive; handler outcomes carry their own status codes. */
    const postRoute = (path: string, label: string, handle: (deps: RouteDeps, body: unknown) => Promise<RouteOutcome>): void => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          send(res, await handle(deps(), await readJson(req)))
        } catch (error) {
          send(res, { status: 400, body: { error: error instanceof Error ? error.message : String(error) } })
        }
      } }), `git-worktree: ${label} route`)
    }

    // The one query-driven route; every mutation is a POST body.
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: ROUTE_STATUS, handler: async (req: IncomingMessage, res: ServerResponse) => {
      /* v8 ignore next -- node:http always sets url on server requests. */
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      send(res, await handleStatus(deps(), query.get('path') ?? undefined))
    } }), 'git-worktree: status route')

    postRoute(ROUTE_WORKTREE, 'worktree', handleCreateWorktree)
    postRoute(ROUTE_SWITCH, 'switch', handleSwitch)
    postRoute(ROUTE_BRANCH, 'branch', handleCreateBranch)
    postRoute(ROUTE_BRANCH_RENAME, 'branch-rename', handleRenameBranch)
    postRoute(ROUTE_BRANCH_DELETE, 'branch-delete', handleDeleteBranch)
    postRoute(ROUTE_FETCH, 'fetch', handleFetch)
    postRoute(ROUTE_GROUP, 'group', handleGroupWorktrees)
    postRoute(ROUTE_UPDATE, 'update', handleUpdate)
    postRoute(ROUTE_PUSH, 'push', handlePush)
    postRoute(ROUTE_INSPECT, 'inspect', handleInspectWorktree)
    postRoute(ROUTE_REMOVE, 'remove', handleRemoveWorktree)
    postRoute(ROUTE_EXISTS, 'exists', handlePathExists)
    postRoute(ROUTE_ENSURE_DIRECTORY, 'ensure-directory', handleEnsureDirectory)
    postRoute(ROUTE_WORKTREES_ALL, 'worktrees-all', handleWorktreesAll)
    postRoute(ROUTE_PURGE, 'purge', handlePurgeDirectory)
    postRoute(ROUTE_CHANGES, 'changes', handleChanges)
    postRoute(ROUTE_STAGE, 'stage', handleStage)
    postRoute(ROUTE_COMMIT, 'commit', handleCommit)
    postRoute(ROUTE_LOG, 'log', handleLog)
    postRoute(ROUTE_COMMIT_FILES, 'commit-files', handleCommitFiles)

    // The AI commit-message route exists only where the host tree provides
    // the dsh-llm service: the injection resolves once the service is up and
    // never fires without it, so an llm-less deployment answers 404 and the
    // browser half hides its AI affordance.
    ctx.inject(['llm'], (llmCtx) => {
      const llm = (llmCtx as unknown as { llm: LlmStreamRuntime }).llm
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: ROUTE_AI_COMMIT_MESSAGE, handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          send(res, await handleAiCommitMessage(deps(), llm, await readJson(req)))
        } catch (error) {
          send(res, { status: 400, body: { error: error instanceof Error ? error.message : String(error) } })
        }
      } }), 'git-worktree: ai-commit-message route')
    })
  })
}
