/**
 * Browser-side fetch client for the plugin's host routes. Plain fetch against
 * same-origin paths; every failure resolves to `{ error }` so callers can
 * branch without try/catch.
 */

import type {
  AiCommitMessageBody, AiCommitMessageResult, ChangesResult, CommitFilesResult, CommitResult, CreateBranchResult, CreateTagResult, CreateWorktreeResult, CredentialDeleteBody, CredentialOAuthPollBody, CredentialOAuthPollResult, CredentialOAuthStartBody, CredentialOAuthStartResult, CredentialSaveBody, CredentialsResult, DeleteBranchResult, EnsureDirectoryResult, FetchResult, GroupWorkspacesResult, InspectWorktreeResult, LogResult, PathExistsResult, PurgeDirectoryResult, PushTagResult, RemoteMutationBody, RemoveWorktreeResult, RemotesResult, RenameBranchResult, RepoStatus, RouteError, StageBody, StageResult, SwitchResult, UpdateResult, PushResult, WorktreesAllResult,
} from '../wire.ts'
import { ROUTE_AI_COMMIT_MESSAGE, ROUTE_BRANCH, ROUTE_BRANCH_DELETE, ROUTE_BRANCH_RENAME, ROUTE_CHANGES, ROUTE_COMMIT, ROUTE_COMMIT_FILES, ROUTE_CREDENTIALS, ROUTE_CREDENTIALS_DELETE, ROUTE_CREDENTIALS_OAUTH_POLL, ROUTE_CREDENTIALS_OAUTH_START, ROUTE_CREDENTIALS_SAVE, ROUTE_ENSURE_DIRECTORY, ROUTE_EXISTS, ROUTE_FETCH, ROUTE_GROUP, ROUTE_INSPECT, ROUTE_LOG, ROUTE_PUSH, ROUTE_PURGE, ROUTE_REMOTE, ROUTE_REMOTES, ROUTE_REMOVE, ROUTE_STAGE, ROUTE_STATUS, ROUTE_SWITCH, ROUTE_TAG, ROUTE_TAG_PUSH, ROUTE_UPDATE, ROUTE_WORKTREE, ROUTE_WORKTREES_ALL } from '../wire.ts'

/** One route call outcome: the parsed body, or the error envelope text. */
type Call<T> = (T & { ok: true }) | { ok: false; error: string }

/** POST one JSON body and parse the uniform envelope. */
async function post<T>(url: string, body: unknown): Promise<Call<T>> {
  return send<T>('POST', url, body)
}

/** Send one JSON body with any method and parse the uniform envelope. */
async function send<T>(method: string, url: string, body: unknown): Promise<Call<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      // An empty or non-JSON body (e.g. a 404 from a host that has not
      // loaded this build yet): the status code is the whole message.
      return { ok: false, error: `HTTP ${String(response.status)}` }
    }
    if (!response.ok) {
      const error = payload as RouteError
      return { ok: false, error: error.error ?? `HTTP ${String(response.status)}` }
    }
    return { ...(payload as T), ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Repository status for one directory.
 * @param path - absolute workspace directory.
 */
export async function fetchStatus(path: string): Promise<Call<RepoStatus>> {
  try {
    const response = await fetch(`${ROUTE_STATUS}?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
    if (!response.ok) return { ok: false, error: `HTTP ${String(response.status)}` }
    return { ...(await response.json() as RepoStatus), ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Create or reuse the worktree for a branch.
 * @param repoPath - absolute directory inside the repository.
 * @param branch - branch display name.
 */
export function requestWorktree(repoPath: string, branch: string): Promise<Call<CreateWorktreeResult>> {
  return post<CreateWorktreeResult>(ROUTE_WORKTREE, { repoPath, branch })
}

/**
 * Cut a NEW branch out of the current checkout and isolate it in a fresh
 * worktree (the current branch itself is occupied by the main worktree).
 * @param repoPath - absolute directory inside the repository.
 * @param branch - the current checkout's branch (or `HEAD` when detached).
 * @param name - explicit name for the new branch; omitted, the host
 * derives `<branch>-wt`, suffixing past taken names.
 */
export function requestWorktreeCutout(repoPath: string, branch: string, name?: string): Promise<Call<CreateWorktreeResult>> {
  return post<CreateWorktreeResult>(ROUTE_WORKTREE, { repoPath, branch, cutout: true, ...(name === undefined ? {} : { name }) })
}

/**
 * Switch the main checkout in place.
 * @param repoPath - absolute directory inside the main worktree.
 * @param branch - branch display name.
 */
export function requestSwitch(repoPath: string, branch: string): Promise<Call<SwitchResult>> {
  return post<SwitchResult>(ROUTE_SWITCH, { repoPath, branch })
}

/**
 * Create a NEW branch. Without `from`: cut from the directory's current
 * checkout and switch to it in place (the original in-place shape). With
 * `from` (a local branch or remote-tracking ref): created AT that start
 * point — left unchecked-out by default (the row menu's 新建), or checked
 * out here too with `checkout` (the row menu's 新建并检出).
 * @param repoPath - absolute directory inside the repository.
 * @param name - user-typed new branch name (validated client-side already).
 * @param from - optional start point; absent keeps the in-place semantics.
 * @param checkout - with `from`, also check the new branch out here.
 */
export function requestCreateBranch(repoPath: string, name: string, from?: string, checkout?: boolean): Promise<Call<CreateBranchResult>> {
  if (from === undefined) return post<CreateBranchResult>(ROUTE_BRANCH, { repoPath, name })
  return post<CreateBranchResult>(ROUTE_BRANCH, { repoPath, name, from, ...(checkout === true ? { checkout: true } : {}) })
}

/**
 * Rename a LOCAL branch (`git branch -m`); repository-wide, worktree HEADs
 * follow.
 * @param repoPath - absolute directory inside the repository.
 * @param name - branch to rename.
 * @param newName - user-typed new name (validated client-side already).
 */
export function requestRenameBranch(repoPath: string, name: string, newName: string): Promise<Call<RenameBranchResult>> {
  return post<RenameBranchResult>(ROUTE_BRANCH_RENAME, { repoPath, name, newName })
}

/**
 * Delete a LOCAL branch with the safe form (`git branch -d`); git refuses
 * unmerged commits and branches checked out in any worktree.
 * @param repoPath - absolute directory inside the repository.
 * @param name - branch to delete.
 */
export function requestDeleteBranch(repoPath: string, name: string): Promise<Call<DeleteBranchResult>> {
  return post<DeleteBranchResult>(ROUTE_BRANCH_DELETE, { repoPath, name })
}

/**
 * Sync remote-tracking refs (fetch every remote + prune) for the repository.
 * @param repoPath - absolute directory inside the repository.
 */
export function requestFetch(repoPath: string): Promise<Call<FetchResult>> {
  return post<FetchResult>(ROUTE_FETCH, { repoPath })
}

/**
 * Update the CURRENT checkout: fetch every remote, then fast-forward the
 * checked-out branch to its upstream.
 * @param repoPath - absolute directory whose checked-out branch is updated.
 */
export function requestUpdate(repoPath: string): Promise<Call<UpdateResult>> {
  return post<UpdateResult>(ROUTE_UPDATE, { repoPath })
}

/**
 * Push the branch checked out by the queried directory to its upstream.
 * @param repoPath - absolute directory whose checked-out branch is pushed.
 */
export function requestPush(repoPath: string): Promise<Call<PushResult>> {
  return post<PushResult>(ROUTE_PUSH, { repoPath })
}

/**
 * Git belonging facts for a batch of workspace directories; a path outside
 * any git repository answers null, a failed route call answers the error
 * envelope (the sidebar then renders flat, its degrade shape).
 * @param paths - absolute workspace directories to probe.
 */
export async function requestGroupWorktrees(paths: readonly string[]): Promise<Call<GroupWorkspacesResult>> {
  return post<GroupWorkspacesResult>(ROUTE_GROUP, { paths })
}

/**
 * Pre-delete facts for one worktree directory: the uncommitted-file count
 * (lost with the folder) and the branch's ahead count (kept).
 * @param path - absolute worktree directory.
 */
export function requestInspectWorktree(path: string): Promise<Call<InspectWorktreeResult>> {
  return post<InspectWorktreeResult>(ROUTE_INSPECT, { path })
}

/**
 * Remove one linked worktree (git registration + folder). `force` rides
 * `--force` past uncommitted changes the confirm dialog already showed.
 * @param path - absolute worktree directory to delete.
 * @param force - delete past uncommitted changes.
 */
export function requestRemoveWorktree(path: string, force: boolean): Promise<Call<RemoveWorktreeResult>> {
  return post<RemoveWorktreeResult>(ROUTE_REMOVE, { path, force })
}

/**
 * Batch directory-existence probe (true = exists AND is a directory). The
 * sidebar gates register-as-workspace on this so a missing folder never
 * reaches the DSH workspace API.
 * @param paths - absolute directories to probe.
 */
export function requestPathExists(paths: readonly string[]): Promise<Call<PathExistsResult>> {
  return post<PathExistsResult>(ROUTE_EXISTS, { paths })
}

/**
 * Recreate a missing worktree storage slot (`mkdir -p`). The host gates this
 * to paths directly inside one of the plugin's storage locations; historical
 * sessions reattach automatically once the directory is back.
 * @param path - the missing slot directory (absolute).
 */
export function requestEnsureDirectory(path: string): Promise<Call<EnsureDirectoryResult>> {
  return post<EnsureDirectoryResult>(ROUTE_ENSURE_DIRECTORY, { path })
}

/**
 * Scan both worktree storage locations: the legacy central root and every
 * repository's `.dsh/gitworktree` derived from the workspace paths. Orphan/
 * foreign folders answer null facts — the manager dialog shows them as
 * unrecognized.
 * @param workspaces - absolute directories of the registered workspaces
 * (drives the project-internal half); absent scans only the legacy root.
 */
export function requestWorktreesAll(workspaces?: readonly string[]): Promise<Call<WorktreesAllResult>> {
  return post<WorktreesAllResult>(ROUTE_WORKTREES_ALL, { ...(workspaces === undefined || workspaces.length === 0 ? {} : { workspaces: [...workspaces] }) })
}

/**
 * Delete a NON-git directory sitting directly inside one of the plugin's
 * storage locations (an orphaned leftover whose .git is already gone). The
 * host triple-gates this: slot boundary, real directory, no git identity —
 * anything git still recognizes must go through requestRemoveWorktree
 * instead.
 * @param path - the leftover directory (absolute).
 */
export function requestPurgeDirectory(path: string): Promise<Call<PurgeDirectoryResult>> {
  return post<PurgeDirectoryResult>(ROUTE_PURGE, { path })
}

/**
 * Working-tree changes of one checkout (staged/unstaged/untracked rows).
 * @param repoPath - absolute directory inside the repository.
 */
export function requestChanges(repoPath: string): Promise<Call<ChangesResult>> {
  return post<ChangesResult>(ROUTE_CHANGES, { repoPath })
}

/**
 * Stage or unstage relative paths of one checkout.
 * @param repoPath - absolute directory inside the repository.
 * @param paths - relative paths from requestChanges output.
 * @param stage - true stages (git add), false unstages (git reset).
 */
export function requestStage(repoPath: string, paths: readonly string[], stage: boolean): Promise<Call<StageResult>> {
  return post<StageResult>(ROUTE_STAGE, { repoPath, paths: [...paths], stage } satisfies StageBody)
}

/**
 * Commit the index with a message.
 * @param repoPath - absolute directory inside the repository.
 * @param message - the commit message, verbatim.
 */
export function requestCommit(repoPath: string, message: string): Promise<Call<CommitResult>> {
  return post<CommitResult>(ROUTE_COMMIT, { repoPath, message })
}

/**
 * What to ask the history endpoint for: a page of commits narrowed by ref,
 * author and a time window. Every field is optional; an absent `ref` means
 * "everything reachable" (`all` widens that to every ref, tags included).
 */
export interface HistoryQuery {
  /** Page size (server-capped at 200). */
  readonly limit?: number
  /** Offset into the history. */
  readonly skip?: number
  /** Starting rev (a branch name); absent = HEAD. */
  readonly ref?: string
  /** Walk every ref, not just the checked-out one. Ignored when `ref` is set. */
  readonly all?: boolean
  /** Restrict to commits whose author matches (a substring, or a `Name <mail>` pair). */
  readonly author?: string
  /** Lower bound of the commit date, epoch milliseconds. */
  readonly since?: number
  /** Upper bound of the commit date, epoch milliseconds. */
  readonly until?: number
}

/**
 * One page of commit history of the checkout.
 * @param repoPath - absolute directory inside the repository.
 * @param query - paging and the branch/author/time narrowing.
 */
export function requestLog(repoPath: string, query: HistoryQuery = {}): Promise<Call<LogResult>> {
  const { limit, skip, ref, all, author, since, until } = query
  return post<LogResult>(ROUTE_LOG, {
    repoPath,
    ...(limit === undefined ? {} : { limit }),
    ...(skip === undefined ? {} : { skip }),
    ...(ref === undefined || ref === '' ? {} : { ref }),
    ...(all === true ? { all } : {}),
    ...(author === undefined || author === '' ? {} : { author }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  })
}

/**
 * The files one commit changed (status letter + +/- line counts).
 * @param repoPath - absolute directory inside the repository.
 * @param hash - the commit hash.
 */
export function requestCommitFiles(repoPath: string, hash: string): Promise<Call<CommitFilesResult>> {
  return post<CommitFilesResult>(ROUTE_COMMIT_FILES, { repoPath, hash })
}

/**
 * Create a tag pointing at one commit (annotated when a message is given,
 * lightweight otherwise). Local only: pushing tags is a separate release step.
 * @param repoPath - absolute directory inside the repository.
 * @param name - the new tag name.
 * @param target - the commit to tag; absent = HEAD.
 * @param message - annotation message; absent = lightweight tag.
 */
export function requestCreateTag(
  repoPath: string,
  name: string,
  target?: string,
  message?: string,
): Promise<Call<CreateTagResult>> {
  return post<CreateTagResult>(ROUTE_TAG, {
    repoPath,
    name,
    ...(target === undefined || target === '' ? {} : { target }),
    ...(message === undefined || message.trim() === '' ? {} : { message }),
  })
}

/**
 * Push ONE local tag to its remote (the host resolves which remote). Unlike
 * {@link requestPush}, which sends the current branch alone.
 * @param repoPath - absolute directory inside the repository.
 * @param name - an existing local tag name (verified host-side).
 */
export function requestPushTag(repoPath: string, name: string): Promise<Call<PushTagResult>> {
  return post<PushTagResult>(ROUTE_TAG_PUSH, { repoPath, name })
}

/**
 * Every stored GLOBAL credential, secrets masked. One row per host: a token
 * saved for github.com serves every repository that talks to github.com.
 */
export function requestCredentials(): Promise<Call<CredentialsResult>> {
  return post<CredentialsResult>(ROUTE_CREDENTIALS, {})
}

/**
 * Create or update the credential of ONE host. A blank `secret` on an
 * existing host keeps the stored secret.
 * @param body - `{ host, username, method, secret? }`.
 */
export function requestSaveCredential(body: CredentialSaveBody): Promise<Call<CredentialsResult>> {
  return post<CredentialsResult>(ROUTE_CREDENTIALS_SAVE, body)
}

/**
 * Forget ONE host's credential.
 * @param body - `{ host }`.
 */
export function requestDeleteCredential(body: CredentialDeleteBody): Promise<Call<CredentialsResult>> {
  return post<CredentialsResult>(ROUTE_CREDENTIALS_DELETE, body)
}

/**
 * Start a browser sign-in for ONE host (GitHub device flow). The answer
 * carries the one-time user code the dialog shows and the verification page
 * it opens.
 * @param body - `{ host }`.
 */
export function requestOAuthStart(body: CredentialOAuthStartBody): Promise<Call<CredentialOAuthStartResult>> {
  return post<CredentialOAuthStartResult>(ROUTE_CREDENTIALS_OAUTH_START, body)
}

/**
 * Poll a started browser sign-in. Resolves `{ status: 'pending' }` until the
 * user approves; then the token is stored host-side and the fresh masked
 * list comes back (the token itself never reaches the browser).
 * @param body - `{ host, deviceCode }`.
 */
export function requestOAuthPoll(body: CredentialOAuthPollBody): Promise<Call<CredentialOAuthPollResult>> {
  return post<CredentialOAuthPollResult>(ROUTE_CREDENTIALS_OAUTH_POLL, body)
}

/**
 * The repository's configured remotes (fetch/push URLs).
 * @param repoPath - absolute directory inside the repository.
 */
export function requestRemotes(repoPath: string): Promise<Call<RemotesResult>> {
  return post<RemotesResult>(ROUTE_REMOTES, { repoPath })
}

/**
 * Add, re-point or remove one remote; resolves with the fresh list.
 * @param body - `{ repoPath, action, name, url? }`.
 */
export function requestMutateRemote(body: RemoteMutationBody): Promise<Call<RemotesResult>> {
  return post<RemotesResult>(ROUTE_REMOTE, body)
}

/**
 * Generate a commit message from the checkout's diff with the requesting
 * session's own model (a one-shot host llm call).
 * @param body - the repo path plus the session's model selection and an
 * optional user hint.
 */
export function requestAiCommitMessage(body: AiCommitMessageBody): Promise<Call<AiCommitMessageResult>> {
  return post<AiCommitMessageResult>(ROUTE_AI_COMMIT_MESSAGE, body)
}
