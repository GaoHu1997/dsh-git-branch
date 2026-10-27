/**
 * Git command wrapper for the host half. All git access goes through one
 * injectable `exec` seam (tests substitute it); every method is plain
 * argument assembly plus porcelain parsing, no ambient state.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { accelerateUrlError, localBranchName, normalizeAccelerateUrl } from './normalize.js'
import type { BranchEntry, WorktreeEntry, WorkspaceGitFacts } from './wire.js'

/** One process result as the seam reports it. */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** Node-level failure text when the process never produced stderr. */
  errorMessage?: string
}

/**
 * Process executor seam. Runs `file args` with cwd set, captures output as
 * UTF-8 text, and never throws — a non-zero exit is a normal result.
 */
export type Exec = (file: string, args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<ExecResult>

/** Failure of one git invocation: non-zero exit with the stderr text. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`)
    this.name = 'GitError'
  }
}

/** Facts the status route assembles: branches, worktrees, repo identity. */
export interface RepoFacts {
  /** Absolute main worktree path (`dirname` of `--git-common-dir`, not the
   * queried directory's `--show-toplevel` — a linked worktree's toplevel
   * dies during `worktree remove`). */
  repoRoot: string
  /** Main repository directory basename. */
  repoName: string
  /** The QUERIED directory's own toplevel — the worktree the session
   * actually sits in. Repository-wide commands (branch refs, fetch,
   * worktree registration) run at {@link RepoFacts.repoRoot}; commands that
   * act on the session's own checkout (switch/update/create-and-check-out)
   * run HERE, or a linked-worktree session would silently operate on the
   * main checkout instead. */
  toplevel: string
  /** Whether the QUERIED directory is the main worktree — see
   * {@link isMainWorktree}. `repoRoot` cannot answer this: it names the main
   * checkout from every worktree by construction. */
  main: boolean
  /** Branch checked out by the queried directory. */
  currentBranch: string
  branches: BranchEntry[]
  /** EVERY remote branch (twins included, `<remote>/HEAD` and bare leftover
   * refs dropped) — the git panel's remote tree lists the full remote view,
   * while {@link RepoFacts.branches} keeps the picker's remote-only dedupe. */
  remoteBranches: BranchEntry[]
  worktrees: WorktreeEntry[]
}

/** Default hard timeout for one git call: generous for every LOCAL
 * operation (status/log/commit/worktree) while still bounding hangs. */
export const GIT_TIMEOUT_MS = 20_000
/** Network operations (fetch/push) get a far wider budget: a slow link with
 * a real pack transfer outruns the local default, and a killed push may have
 * ALREADY updated the remote refs — an error toast for a push that actually
 * landed. 120s still bounds a hung credential prompt. */
export const NETWORK_TIMEOUT_MS = 120_000

/** Real executor over node:child_process with a hard timeout. */
export function childProcessExec(file: string, args: readonly string[], options: { cwd: string; timeoutMs?: number }): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { cwd: options.cwd, encoding: 'utf8', timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolvePromise({
        code,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        ...(error instanceof Error ? { errorMessage: error.message } : {}),
      })
    })
  })
}

/** Run one git command; a non-zero exit raises {@link GitError} with stderr. */
async function git(exec: Exec, cwd: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const result = await exec('git', args, { cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  if (result.code !== 0) {
    const diagnostic = result.stderr.trim() !== ''
      ? result.stderr
      : result.stdout.trim() !== ''
        ? result.stdout
        : result.errorMessage ?? 'git produced no diagnostic output'
    throw new GitError(args, result.code, diagnostic)
  }
  return result.stdout
}

/** Run one git command, mapping a non-zero exit to undefined instead of throwing. */
async function gitMaybe(exec: Exec, cwd: string, args: readonly string[], timeoutMs?: number): Promise<string | undefined> {
  const result = await exec('git', args, { cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  return result.code === 0 ? result.stdout : undefined
}

/** Directory-existence seam over the parsed worktree registrations. */
export type DirExists = (path: string) => boolean

/** Real existence check. */
export const fsDirExists: DirExists = path => existsSync(path)

/**
 * Leftover-directory sweeper after `git worktree remove` unregisters but
 * fails the final rmdir (Windows EPERM when a process still has the folder
 * as cwd). `gone` = deleted; `empty` = still there but vacant (cwd hold);
 * `occupied` = still has files — the caller must not pretend removal finished.
 */
export type SweepDir = (path: string) => Promise<'gone' | 'empty' | 'occupied'>

/** Real leftover sweep: `fs.rm` with Windows EPERM retries, then classify. */
export async function fsSweepDir(path: string): Promise<'gone' | 'empty' | 'occupied'> {
  if (!existsSync(path)) return 'gone'
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  } catch {
    // Retries exhausted; classify whatever is still on disk.
  }
  if (!existsSync(path)) return 'gone'
  try {
    return readdirSync(path).length === 0 ? 'empty' : 'occupied'
  } catch {
    return 'occupied'
  }
}

/** stderr of a git rmdir that lost to an OS file lock (not git's dirty check). */
function isDirBusyGitError(error: GitError): boolean {
  const text = error.stderr
  return /permission denied/i.test(text)
    || /\bEPERM\b/i.test(text)
    || /\bEACCES\b/i.test(text)
    || /\bEBUSY\b/i.test(text)
}

/**
 * Whether a directory IS the main worktree of its repository: exactly when
 * its own toplevel holds the SHARED `.git` that `--git-common-dir` names.
 * From a linked worktree that path resolves to the shared `<repo>/.git` too,
 * but its toplevel is the linked folder — so the two differ and the answer
 * is false.
 *
 * Deliberately NOT "is the first entry of `worktree list`": that list is
 * filtered by directory existence downstream (a stale main registration
 * would flip the answer), it costs a second git spawn, and its `main` flag
 * describes a different question — which entry git considers main, not
 * which directory was asked about. Same rule as {@link probeWorkspaceGit}
 * applies for the sidebar's grouping, extracted here so both answers are the
 * same answer.
 * @param toplevel - the queried directory's own `--show-toplevel`.
 * @param gitDir - the SHARED git dir (`--git-common-dir`) every worktree
 * resolves back to.
 */
/**
 * Whether two paths refer to the same directory on disk, accounting for
 * trailing slashes, slash directions, and Windows case-insensitivity.
 */
function isSamePath(a: string, b: string): boolean {
  const normA = normalize(resolve(a))
  const normB = normalize(resolve(b))
  return process.platform === 'win32'
    ? normA.toLowerCase() === normB.toLowerCase()
    : normA === normB
}

function isMainWorktree(toplevel: string, gitDir: string): boolean {
  return isSamePath(resolve(toplevel, '.git'), gitDir)
}

/**
 * Resolve a directory to repository facts, or undefined outside any git
 * repository (including the `git` binary missing: ENOENT surfaces as a
 * non-zero exit through the seam).
 * @param exec - executor seam.
 * @param path - absolute directory the workspace reports.
 * @param dirExists - existence seam for stale-registration filtering.
 */
export async function probeRepo(exec: Exec, path: string, dirExists: DirExists = fsDirExists): Promise<RepoFacts | undefined> {
  const top = await gitMaybe(exec, path, ['rev-parse', '--show-toplevel'])
  if (top === undefined) return undefined
  const commonDir = await gitMaybe(exec, path, ['rev-parse', '--git-common-dir'])
  // repoName comes from the shared .git location: a linked worktree's own
  // toplevel would name the branch folder, not the repository. Both git
  // outputs carry forward slashes on Windows — normalize every derived path.
  const toplevel = normalize(top.trim())
  const gitDir = commonDir !== undefined && commonDir.trim() !== ''
    ? normalize(resolve(path, commonDir.trim()))
    : resolve(toplevel, '.git')
  // Main worktree, not the queried directory: a linked worktree's
  // `--show-toplevel` is its own folder, which `git worktree remove` then
  // destroys (including `.git`). Later `worktree list` / `worktree prune`
  // must still run in a living git dir — the shared checkout
  // (`dirname(--git-common-dir)`), same grouping key as probeWorkspaceGit.
  const repoRoot = dirname(gitDir)
  return {
    repoRoot,
    repoName: basename(dirname(gitDir)),
    toplevel,
    main: isMainWorktree(toplevel, gitDir),
    currentBranch: await currentBranch(exec, path),
    ...await listBranches(exec, repoRoot),
    // A stale registration (directory removed behind git's back) must not
    // reach the UI as a real worktree — it would disable branch rows for a
    // folder that no longer exists.
    worktrees: (await listWorktrees(exec, repoRoot)).filter(w => dirExists(w.path)),
  }
}

/** Currently checked-out branch of a directory; `HEAD` when detached or unborn. */
async function currentBranch(exec: Exec, cwd: string): Promise<string> {
  const name = await gitMaybe(exec, cwd, ['branch', '--show-current'])
  const trimmed = name?.trim() ?? ''
  return trimmed === '' ? 'HEAD' : trimmed
}

/**
 * Local branches (each carrying its ahead/behind vs the upstream when one
 * exists) plus remote branches across EVERY remote (`<remote>/HEAD` and bare
 * leftover refs dropped), in two shapes: `branches` keeps the picker's
 * remote-only dedupe (a remote branch with a local twin stays out — the twin
 * is the actionable row), `remoteBranches` is the FULL remote view (twins
 * included) the git panel's remote tree lists.
 *
 * The upstream track comes from `%(upstream:track)`, which renders
 * `[ahead N, behind M]` (or a bare `[gone]`) directly after the refname —
 * `[` is illegal in refnames, so `indexOf('[')` splits name from track
 * without a separator. `[gone]` (upstream deleted server-side) carries no
 * counts and is dropped here; the UI renders no marker for it.
 */
async function listBranches(exec: Exec, repoRoot: string): Promise<{ branches: BranchEntry[]; remoteBranches: BranchEntry[] }> {
  const localOut = await git(exec, repoRoot, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%(upstream:track)'])
  const entries: BranchEntry[] = []
  for (const line of localOut.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const bracket = trimmed.indexOf('[')
    const name = (bracket === -1 ? trimmed : trimmed.slice(0, bracket)).trim()
    if (name === '') continue
    const track = bracket === -1 ? '' : trimmed.slice(bracket)
    const ahead = /\bahead (\d+)/.exec(track)
    const behind = /\bbehind (\d+)/.exec(track)
    const entry: BranchEntry = { name, kind: 'local' }
    if (ahead !== null) entry.ahead = Number(ahead[1])
    if (behind !== null) entry.behind = Number(behind[1])
    entries.push(entry)
  }
  const remoteOut = await gitMaybe(exec, repoRoot, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)'])
  const remoteBranches: BranchEntry[] = []
  if (remoteOut !== undefined) {
    // Local names as a Set: the twin lookup runs once per remote row, and a
    // linear scan over the assembled list would make the loop quadratic —
    // felt at thousand-branch repos, free to avoid.
    const localNames = new Set(entries.filter(e => e.kind === 'local').map(e => e.name))
    for (const line of remoteOut.split('\n')) {
      const name = line.trim()
      if (name === '') continue
      const localName = localBranchName(name)
      // A bare ref directly under refs/remotes (shortname without `/`, like
      // a leftover `refs/remotes/origin`) is not a remote branch — git
      // branch -r hides it, the menu must not offer it either. `<remote>/HEAD`
      // is a symbolic pointer, not a branch, and drops from both lists.
      if (localName === name || localName === 'HEAD') continue
      remoteBranches.push({ name, kind: 'remote' })
      // A remote branch with a local twin stays out of the picker group:
      // the twin is the actionable row, showing both would duplicate it in
      // the menu. The full list above keeps it for the panel's tree.
      if (localNames.has(localName)) continue
      entries.push({ name, kind: 'remote' })
    }
  }
  return { branches: entries, remoteBranches }
}

/** Parse `git worktree list --porcelain` into entries, main first. */
async function listWorktrees(exec: Exec, repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await git(exec, repoRoot, ['worktree', 'list', '--porcelain'])
  const entries: WorktreeEntry[] = []
  let path: string | undefined
  let branch: string | undefined
  let detached = false
  const flush = (): void => {
    if (path === undefined) return
    // Porcelain reports forward slashes on Windows; normalize so consumers
    // can compare against join()-built paths.
    entries.push({ path: normalize(path), branch: detached || branch === undefined ? undefined : branch.replace('refs/heads/', ''), main: entries.length === 0 })
    path = undefined
    branch = undefined
    detached = false
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim()
    } else if (line === 'detached') {
      detached = true
    }
  }
  flush()
  return entries
}

/**
 * Resolve a branch display name against the authoritative branch list of the
 * repository. Exported for the /worktree route's fetch gate: the pre-create
 * remote sync only earns its round trip when the display name is REMOTE-only
 * (a local branch's worktree never consumes fetched refs).
 * @returns the local name plus the tracking remote when the display name is
 * remote-only, or undefined when neither shape exists.
 */
export async function resolveBranch(exec: Exec, repoRoot: string, branch: string): Promise<{ local: string; remote: string | undefined } | undefined> {
  const localsOut = await git(exec, repoRoot, ['for-each-ref', 'refs/heads', '--format=%(refname:short)'])
  const locals = localsOut.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (locals.includes(branch)) return { local: branch, remote: undefined }
  // A name without `/` can never name a remote branch — `<remote>/<name>`
  // always carries the slash. This guards the leftover bare `refs/remotes/<x>`
  // ref too: matching it would compute a garbage remote part.
  if (!branch.includes('/')) return undefined
  const local = localBranchName(branch)
  if (local !== branch && locals.includes(local)) return undefined // the display names a remote, but the local twin exists: use the twin
  const remoteOut = await gitMaybe(exec, repoRoot, ['for-each-ref', 'refs/remotes', `refs/remotes/${branch}`, '--format=%(refname:short)'])
  if (remoteOut !== undefined && remoteOut.trim() !== '') return { local, remote: branch.slice(0, branch.length - local.length - 1) }
  return undefined
}

/**
 * Create (or reuse) the worktree for one branch.
 *
 * Idempotence: git allows one worktree per checked-out branch, so an existing
 * worktree already on `branch` (compared by local name) is returned unreused.
 * A local branch gets `git worktree add <path> <name>`; a remote-only branch
 * gets a new local twin via `git worktree add <path> -b <name> <remoteRef>`.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param branch - branch display name.
 * @param targetPath - absolute directory to create.
 * @returns the worktree path and whether this call created it.
 */
export async function addWorktree(
  exec: Exec,
  repoRoot: string,
  branch: string,
  targetPath: string,
  dirExists: DirExists = fsDirExists,
): Promise<{ path: string; created: boolean }> {
  const resolved = await resolveBranch(exec, repoRoot, branch)
  if (resolved === undefined) throw new GitError(['worktree', 'add'], 1, `branch "${branch}" not found`)
  let worktrees = await listWorktrees(exec, repoRoot)
  const existing = worktrees.find(w => w.branch === resolved.local)
  if (existing !== undefined && dirExists(existing.path)) return { path: existing.path, created: false }
  if (existing !== undefined) {
    // Stale registration: the directory is gone but git's administrative
    // record still claims the branch. Prune (git-side no-op when clean) and
    // re-read before creating, or `worktree add` would refuse the branch.
    await git(exec, repoRoot, ['worktree', 'prune'])
    worktrees = await listWorktrees(exec, repoRoot)
    const afterPrune = worktrees.find(w => w.branch === resolved.local)
    if (afterPrune !== undefined && dirExists(afterPrune.path)) return { path: afterPrune.path, created: false }
  }
  if (resolved.remote === undefined) {
    await git(exec, repoRoot, ['worktree', 'add', targetPath, resolved.local])
  } else {
    await git(exec, repoRoot, ['worktree', 'add', targetPath, '-b', resolved.local, branch])
  }
  return { path: targetPath, created: true }
}

/**
 * Plan a new branch name to cut out of `base`: `<base>-wt`, or the first
 * `-wt<N>` suffix not already taken (`main` → `main-wt`; if that exists,
 * `main-wt2`, …). One `for-each-ref` pass decides; the worktree folder
 * name derives from the returned name, so the caller should resolve it
 * BEFORE computing the target path. With `folderTaken` given, a name is
 * only free when its storage folder is free too: a leftover folder of a
 * since-deleted branch would otherwise fail `worktree add` with a bare
 * "already exists" — the suffix walk skips it the same way.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param base - base branch local name (or `HEAD` when detached).
 * @param folderTaken - storage-folder occupancy probe (branch name → taken).
 * @returns the free cutout branch name.
 */
export async function cutoutBranchName(
  exec: Exec,
  repoRoot: string,
  base: string,
  folderTaken?: (branch: string) => boolean,
): Promise<string> {
  const out = await git(exec, repoRoot, ['for-each-ref', 'refs/heads', '--format=%(refname:short)'])
  const locals = new Set(out.split('\n').map(l => l.trim()).filter(l => l !== ''))
  // `base` is the checked-out branch (`branch --show-current` output), which
  // never carries a remote prefix — pass it through verbatim so a local name
  // containing '/' survives.
  const free = (candidate: string): boolean =>
    !locals.has(candidate) && !(folderTaken?.(candidate) ?? false)
  const stem = `${base}-wt`
  if (free(stem)) return stem
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}${i}`
    if (free(candidate)) return candidate
  }
}

/**
 * Create a worktree on a brand-new branch cut out of `base`: the base is
 * checked out by the main worktree (git forbids a second worktree on it),
 * so the new branch is created from it and checked out in the fresh
 * worktree instead.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param base - base branch local name (`main` or `HEAD`).
 * @param newBranch - the cutout branch name (see {@link cutoutBranchName}).
 * @param targetPath - absolute directory to create.
 */
export async function addWorktreeCutout(
  exec: Exec,
  repoRoot: string,
  base: string,
  newBranch: string,
  targetPath: string,
): Promise<void> {
  await git(exec, repoRoot, ['worktree', 'add', targetPath, '-b', newBranch, base])
}

/**
 * In-place branch switch of one checkout. A remote display name relies
 * on git's dwim: `git switch <local>` creates the tracking branch when
 * exactly one remote has it.
 * @param exec - executor seam.
 * @param checkoutDir - the directory whose OWN checkout moves: the queried
 * session's toplevel, so a linked worktree switches itself rather than the
 * main checkout. `worktree prune` still runs here (it is repo-wide).
 * @param branch - branch display name.
 * @returns the local branch name now checked out.
 */
export async function switchBranch(exec: Exec, checkoutDir: string, branch: string): Promise<string> {
  const resolved = await resolveBranch(exec, checkoutDir, branch)
  if (resolved === undefined) throw new GitError(['switch'], 1, `branch "${branch}" not found`)
  try {
    await git(exec, checkoutDir, ['switch', resolved.local])
  } catch (error) {
    // A stale worktree registration claims the branch; prune (no-op on a
    // healthy repo) and retry once — a live worktree still refuses, as it must.
    const stale = error instanceof GitError && error.stderr.includes('already used by worktree')
    if (!stale) throw error
    await git(exec, checkoutDir, ['worktree', 'prune'])
    await git(exec, checkoutDir, ['switch', resolved.local])
  }
  return resolved.local
}

/**
 * Create a NEW branch. Three shapes:
 *
 *   - no `from`: cut from the current checkout and check it out in place
 *     (`git switch -c`) — the cut point is whatever the queried directory's
 *     HEAD points at, so a detached or unborn checkout cuts from the current
 *     commit too. Runs at the queried directory's own toplevel — a session
 *     inside a linked worktree creates and checks out within that worktree,
 *     never the main checkout (the same semantics as {@link switchBranch}).
 *   - `from` without `checkout`: create AT that start point WITHOUT touching
 *     any checkout (`git branch`) — a create aimed at another branch must
 *     not move this session's HEAD.
 *   - `from` with `checkout`: create at the start point AND check it out
 *     here in one stroke (`git switch -c <name> <from>`).
 * @param exec - executor seam.
 * @param cwd - directory whose HEAD the branch is cut from (worktree toplevel).
 * @param name - new branch name (git validates; failures raise GitError).
 * @param from - optional start point; absent keeps the in-place semantics.
 * @param checkout - with `from`, also check the new branch out here.
 * @returns the branch name now created (checked out unless created at a
 * start point with `checkout` false).
 */
export async function createBranch(exec: Exec, cwd: string, name: string, from?: string, checkout = false): Promise<string> {
  if (from === undefined || checkout) {
    const startPoint = from === undefined ? [] : [from]
    await git(exec, cwd, ['switch', '-c', name, ...startPoint])
    return name
  }
  await git(exec, cwd, ['branch', name, from])
  return name
}

/** Outcome of {@link createTag}: the tag created and the commit it points at. */
export interface TagOutcome {
  tag: string
  hash: string
}

/**
 * Create a tag at an existing commit (`git tag`). Tags are repository-wide
 * refs, so the command runs at the repository root.
 *
 * A message makes it an ANNOTATED tag (`-a -m`) — the only shape that carries
 * an author and date, and what `git describe` prefers; without one the tag is
 * lightweight and is just an alias for the commit. Both are created locally
 * only: pushing a tag is a deliberate, separate publish step that this panel
 * does not perform on a menu click.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param name - tag name (git validates; failures raise GitError).
 * @param target - commit to tag; absent tags the repository's current HEAD.
 * @param message - optional annotation message; non-empty = annotated tag.
 * @returns the tag name and the commit hash it points at.
 */
export async function createTag(exec: Exec, repoRoot: string, name: string, target?: string, message?: string): Promise<TagOutcome> {
  const text = message?.trim() ?? ''
  const args = ['tag']
  if (text !== '') args.push('-a', name, '-m', text)
  else args.push(name)
  if (target !== undefined && target !== '') args.push(target)
  await git(exec, repoRoot, args)
  const hash = (await git(exec, repoRoot, ['rev-list', '-n', '1', name])).trim()
  return { tag: name, hash }
}

/**
 * Rename a LOCAL branch (`git branch -m`): branch refs are repository-wide,
 * so the command runs at the repository root and every worktree HEAD pointing
 * at the old name follows the ref. Git validates the new name and refuses a
 * target that already exists; remote branches are not renameable (not ours).
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param name - branch to rename.
 * @param newName - the new local name.
 * @returns the new name.
 */
export async function renameBranch(exec: Exec, repoRoot: string, name: string, newName: string): Promise<string> {
  await git(exec, repoRoot, ['branch', '-m', name, newName])
  return newName
}

/**
 * Delete a LOCAL branch (`git branch -d`, the SAFE form): git refuses a
 * branch with unmerged commits ("not fully merged") and one checked out in
 * any worktree — both caller-side state, mapped to 400 by the route. No
 * `-D` force variant on purpose: a menu click must never discard commits
 * (the terminal is the place for deliberate force-deletes). Runs at the
 * repository root; remote branches are not ours to delete.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param name - branch to delete.
 * @returns the name of the branch that was deleted.
 */
export async function deleteBranch(exec: Exec, repoRoot: string, name: string): Promise<string> {
  await git(exec, repoRoot, ['branch', '-d', name])
  return name
}

/**
 * argv prefix for network READ commands when cn-accelerate is on: the
 * per-command `url.<base>.insteadOf=https://github.com/` rewrite. Per-command
 * `git -c` (before the subcommand) rather than the user's global git config —
 * the plugin must never persist settings on the user's behalf, and one
 * injected value cannot leak into unrelated git runs. Rewrites
 * `https://github.com/o/r.git` → `<base>https://github.com/o/r.git`, which is
 * how public mirror prefixes consume GitHub URLs.
 * @param prefix - the accelerate URL (raw or normalized); undefined = off.
 * @returns the `-c` pair to prepend, or `[]` when off or the value is
 * unusable (an invalid value fails SAFE to a direct connection — config
 * validation rejects such values at load; this is the defensive path).
 */
export function accelArgs(prefix: string | undefined): readonly string[] {
  if (prefix === undefined || accelerateUrlError(prefix) !== undefined) return []
  return ['-c', `url.${normalizeAccelerateUrl(prefix)}.insteadOf=https://github.com/`]
}

/**
 * Sync remote-tracking refs: fetch every remote and prune tracking branches
 * the remotes no longer carry (the CLI equivalent of IDEA's "synchronize
 * remote branches"). Pure metadata — the working tree, local branches, and
 * the current checkout are untouched; a slow network surfaces through the
 * executor's hard timeout as a GitError.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory (fetch is repository-wide).
 * @param accelPrefix - optional cn-accelerate mirror prefix (see
 * {@link accelArgs}); only the READ half of the network commands gets it.
 */
export async function fetchAll(exec: Exec, repoRoot: string, accelPrefix?: string): Promise<void> {
  await git(exec, repoRoot, [...accelArgs(accelPrefix), 'fetch', '--all', '--prune'], NETWORK_TIMEOUT_MS)
}

/** Outcome of {@link updateBranch}: the branch touched and whether it moved. */
export interface UpdateOutcome {
  branch: string
  updated: boolean
}

/**
 * Update the CURRENT checkout: fetch every remote, then fast-forward the
 * branch checked out by `cwd` to its upstream (`@{u}`) — IDEA's "update
 * selected branch" in its default merge mode. Deliberately `--ff-only`:
 * a diverged local branch refuses rather than silently rebase/merge, and
 * uncommitted working-tree changes are git's own call to reject — the
 * plugin never stashes behind the user's back. Runs at the queried
 * directory's own toplevel, so a linked-worktree session updates the
 * branch ITS worktree holds.
 * @param exec - executor seam.
 * @param cwd - directory whose checked-out branch is updated.
 * @param accelPrefix - optional cn-accelerate mirror prefix; feeds ONLY the
 * fetch phase ({@link fetchAll}) — the `--ff-only` merge is local.
 * @returns the branch name and whether HEAD actually moved (false = the
 * upstream already contained it).
 */
export async function updateBranch(exec: Exec, cwd: string, accelPrefix?: string): Promise<UpdateOutcome> {
  await fetchAll(exec, cwd, accelPrefix)
  const before = (await git(exec, cwd, ['rev-parse', 'HEAD'])).trim()
  await git(exec, cwd, ['merge', '--ff-only', '@{u}'])
  const after = (await git(exec, cwd, ['rev-parse', 'HEAD'])).trim()
  const branch = (await gitMaybe(exec, cwd, ['branch', '--show-current']))?.trim() ?? ''
  return { branch, updated: before !== after }
}

/** Outcome of {@link pushBranch}: the branch touched and whether it moved. */
export interface PushOutcome {
  branch: string
  pushed: boolean
}

/**
 * Push the branch checked out by `cwd` to its upstream (`@{u}`) — the
 * counterpart of {@link updateBranch}. Deliberately a bare `git push`: the
 * branch must already have an upstream (a no-upstream branch refuses with
 * git's own message rather than silently picking one), and `--force` is
 * never passed — a diverged remote refuses rather than losing commits.
 * Runs at the queried directory's own toplevel, so a linked-worktree
 * session pushes the branch ITS worktree holds. The cn-accelerate rewrite is
 * deliberately NEVER injected here (no {@link accelArgs} parameter exists):
 * public mirrors have no `receive-pack`, and rewriting would turn a
 * diagnosable direct failure into an opaque mirror failure while leaking the
 * pushed content to a third party.
 * @param exec - executor seam.
 * @param cwd - directory whose checked-out branch is pushed.
 * @returns the branch and whether the remote-tracking ref changed. A branch
 * without an upstream can still be handed to `git push`, so Git's own
 * push-specific diagnostic is preserved; in that case `pushed` is false.
 */
export async function pushBranch(exec: Exec, cwd: string): Promise<PushOutcome> {
  const before = await gitMaybe(exec, cwd, ['rev-parse', '@{u}'])
  await git(exec, cwd, ['push'], NETWORK_TIMEOUT_MS)
  const after = await gitMaybe(exec, cwd, ['rev-parse', '@{u}'])
  const branch = (await gitMaybe(exec, cwd, ['branch', '--show-current']))?.trim() ?? ''
  return { branch, pushed: before !== undefined && after !== undefined && before.trim() !== after.trim() }
}

/** Every LOCAL tag name of the repository, in git's own sort order. */
export async function listTagNames(exec: Exec, cwd: string): Promise<string[]> {
  const text = await git(exec, cwd, ['for-each-ref', 'refs/tags', '--format=%(refname:short)'])
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** Where a one-off push should go, or why no remote could be picked. */
export type PushRemoteChoice =
  | { readonly ok: true; readonly remote: string }
  | { readonly ok: false; readonly message: string }

/**
 * Pick the remote ONE tag push goes to, in fallback order: the checked-out
 * branch's upstream remote, `remote.pushDefault`, then the only remote there
 * is. Ambiguity is reported instead of guessed — a tag pushed to the wrong
 * remote is a published mistake, not an inconvenience.
 * @param exec - executor seam.
 * @param cwd - directory whose checked-out branch supplies the upstream.
 * @returns the remote name, or the caller-side reason none could be chosen.
 */
export async function resolvePushRemote(exec: Exec, cwd: string): Promise<PushRemoteChoice> {
  const upstream = (await gitMaybe(exec, cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim() ?? ''
  const slash = upstream.indexOf('/')
  if (slash > 0) return { ok: true, remote: upstream.slice(0, slash) }
  const pushDefault = (await gitMaybe(exec, cwd, ['config', '--get', 'remote.pushDefault']))?.trim() ?? ''
  if (pushDefault !== '') return { ok: true, remote: pushDefault }
  const remotes = ((await gitMaybe(exec, cwd, ['remote'])) ?? '')
    .split('\n').map(line => line.trim()).filter(line => line !== '')
  const only = remotes.length === 1 ? remotes[0] : undefined
  if (only !== undefined) return { ok: true, remote: only }
  return { ok: false, message: remotes.length === 0
    ? 'no remote to push the tag to: the current branch has no upstream and the repository has none either'
    : `multiple remotes (${remotes.join(', ')}) and the current branch has no upstream: set one, or git config remote.pushDefault <name>` }
}

/** Outcome of {@link pushTag}: the tag, where it went, and whether it moved. */
export interface TagPushOutcome {
  tag: string
  remote: string
  pushed: boolean
}

/**
 * Push ONE existing local tag to `remote` (`git push <remote>
 * refs/tags/<name>:refs/tags/<name>`) — the publish step a tag needs and a
 * branch push never performs: `git push` sends the current branch alone, so a
 * tag made on an already-pushed commit is invisible to the remote.
 *
 * The tag must already exist locally (the route verifies it against
 * {@link listTagNames}); a remote that already carries the SAME tag object is
 * reported as `pushed: false` without running the push at all. The refspec
 * always names both sides explicitly, so no configured push refspec (a mirror,
 * a `push.default=upstream` branch) can widen what a menu click publishes, and
 * tags are never deleted or overwritten: `--force` is deliberately absent, and
 * a remote tag pointing somewhere else makes git refuse (mapped to 400).
 *
 * The cn-accelerate rewrite is never injected here (no {@link accelArgs}
 * parameter exists, like {@link pushBranch}): a mirror has no `receive-pack` —
 * and the pre-push probe must see the very remote the push targets, or the
 * `pushed` flag would compare two different servers.
 * @param exec - executor seam.
 * @param cwd - any directory inside the repository (tag refs are shared).
 * @param name - an existing local tag name.
 * @param remote - the remote to publish to (see {@link resolvePushRemote}).
 * @returns the tag, the remote, and whether the push had to run.
 */
export async function pushTag(exec: Exec, cwd: string, name: string, remote: string): Promise<TagPushOutcome> {
  const ref = `refs/tags/${name}`
  const local = (await git(exec, cwd, ['rev-parse', '--verify', ref])).trim()
  const listed = await gitMaybe(exec, cwd, ['ls-remote', '--refs', remote, ref], NETWORK_TIMEOUT_MS)
  const present = (listed ?? '').split('\n')
    .map(line => line.trim().split(/\s+/)[0] ?? '')
    .includes(local)
  if (present) return { tag: name, remote, pushed: false }
  await git(exec, cwd, ['push', remote, `${ref}:${ref}`], NETWORK_TIMEOUT_MS)
  return { tag: name, remote, pushed: true }
}

/** Guard for route inputs: a non-empty absolute directory path. */
export function isAbsoluteDir(value: string): boolean {
  return value.trim() !== '' && isAbsolute(value)
}

/** Pre-delete facts of one worktree directory, for the remove-confirm dialog. */
export interface WorktreeInspect {
  /** Uncommitted-change file rows (`git status --porcelain` line count). */
  dirty: number
  /** Commits ahead of the branch's upstream; undefined when no upstream. */
  ahead: number | undefined
}

/**
 * Inspect one worktree directory for removal: how many files carry
 * uncommitted changes (those ARE lost with the folder), and how many commits
 * the checked-out branch leads its upstream by (informational only — the
 * branch ref survives `worktree remove`, so those are kept).
 * @param exec - executor seam.
 * @param worktreePath - the worktree directory (absolute).
 */
export async function inspectWorktree(exec: Exec, worktreePath: string): Promise<WorktreeInspect> {
  const status = await git(exec, worktreePath, ['status', '--porcelain'])
  const dirty = status.split('\n').filter(line => line.trim() !== '').length
  // No upstream (local-only branch) fails the rev-list — that is a normal
  // answer, not an error: ahead stays undefined.
  const aheadOut = await gitMaybe(exec, worktreePath, ['rev-list', '--count', '@{u}..HEAD'])
  const parsed = aheadOut === undefined ? Number.NaN : Number(aheadOut.trim())
  return { dirty, ahead: Number.isFinite(parsed) ? parsed : undefined }
}

/**
 * Remove one linked worktree: `git worktree remove` deletes the folder and
 * the registration in one stroke. A stale registration (folder already gone
 * behind git's back) resolves through `worktree prune` instead — the outcome
 * the user asked for either way, which keeps the route idempotent.
 * @param exec - executor seam.
 * @param repoRoot - main worktree directory.
 * @param worktreePath - the linked worktree directory to delete (absolute).
 * @param force - pass `--force` past uncommitted changes.
 * @param dirExists - existence seam for the stale-registration branch.
 * @param sweepDir - leftover rmdir after git unregisters but the OS holds the
 * folder (Windows Permission denied on the empty directory).
 * @returns the path plus whether only a stale registration was pruned.
 * @throws GitError for the main worktree, an unregistered path, or a refused
 * removal (git's own stderr verbatim).
 */
export async function removeWorktree(
  exec: Exec,
  repoRoot: string,
  worktreePath: string,
  force: boolean,
  dirExists: DirExists = fsDirExists,
  sweepDir: SweepDir = fsSweepDir,
): Promise<{ path: string; pruned: boolean }> {
  const target = normalize(worktreePath)
  const worktrees = await listWorktrees(exec, repoRoot)
  const registered = worktrees.find(w => w.path === target)
  if (registered === undefined) {
    throw new GitError(['worktree', 'remove'], 1, `"${target}" is not a registered worktree of this repository`)
  }
  if (registered.main) {
    throw new GitError(['worktree', 'remove'], 1, 'cannot remove the main worktree')
  }
  if (!dirExists(target)) {
    // Stale registration: the folder is already gone, so removal means
    // clearing git's administrative record — exactly what prune does.
    await git(exec, repoRoot, ['worktree', 'prune'])
    return { path: target, pruned: true }
  }
  try {
    await git(exec, repoRoot, force ? ['worktree', 'remove', '--force', target] : ['worktree', 'remove', target])
    return { path: target, pruned: false }
  } catch (error) {
    // Windows: git often unregisters the worktree and empties the tree,
    // then fails the last rmdir (`Permission denied`) because some process
    // still has the folder as cwd. `--force` does not help — that flag only
    // bypasses dirty/lock checks, not OS handles. Relist from `repoRoot`
    // (the main checkout, which still has `.git`); listing from the target
    // path would throw "not a git repository" once git has stripped its
    // `.git`. If the registration is already gone, the git side is done;
    // sweep the leftover and succeed so the DSH archive+unregister half
    // can run. A still-occupied leftover (files remain) is a real refusal.
    if (!(error instanceof GitError) || !isDirBusyGitError(error)) throw error
    const remaining = (await listWorktrees(exec, repoRoot)).find(w => w.path === target)
    if (remaining !== undefined) throw error
    if (!dirExists(target)) return { path: target, pruned: false }
    const leftover = await sweepDir(target)
    if (leftover === 'occupied') throw error
    return { path: target, pruned: false }
  }
}

/**
 * Lightweight git belonging probe for ONE workspace directory: the three
 * facts the sidebar grouping needs and nothing else (no branch list, no
 * worktree list — {@link probeRepo} stays the full-facts path for the chip).
 *
 * All three facts come from ONE `git rev-parse` invocation: the sidebar
 * probes every registered workspace on each mount, and on Windows every git
 * call is a process spawn, so three sequential spawns per directory made the
 * startup probe cost scale with the workspace count directly. `rev-parse`
 * evaluates each flag in turn and prints one line per answer, so
 * `--show-toplevel`, `--git-common-dir`, and `--abbrev-ref HEAD` fold into a
 * single process.
 *
 * `repoRoot` — the grouping key — is derived from `--git-common-dir`, which
 * names the SHARED `<repo>/.git` from every worktree of the repository: the
 * main checkout reports it directly, a linked worktree reports the path back
 * to it. Both therefore resolve to the same repository root and group
 * together, wherever the linked folder physically lives.
 * `main` is decided without `worktree list`: a directory is the main worktree
 * exactly when its own toplevel holds that shared .git.
 * `branch` uses `--abbrev-ref HEAD`, whose detached/unborn output is git's
 * synthetic `HEAD` — normalized to null HERE so no consumer downstream ever
 * string-compares against it (the same contract the old `branch
 * --show-current` empty output mapped to).
 * @param exec - executor seam.
 * @param path - absolute directory the workspace reports.
 * @returns the facts, or undefined outside any git repository (a missing git
 * binary surfaces the same way — a non-zero exit through the seam).
 */
export async function probeWorkspaceGit(exec: Exec, path: string): Promise<WorkspaceGitFacts | undefined> {
  const out = await gitMaybe(exec, path, ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'])
  if (out === undefined) return undefined
  const lines = out.split('\n').map(line => line.trim())
  const top = lines[0] ?? ''
  const commonDir = lines[1] ?? ''
  const branchName = lines[2] ?? ''
  if (top === '' || commonDir === '') return undefined
  const toplevel = normalize(top)
  // A directory whose git toplevel is an ancestor is an ordinary subdirectory,
  // not an independent worktree or repository root.
  if (!isSamePath(toplevel, path)) return undefined
  // Git outputs carry forward slashes on Windows — normalize every derived
  // path so consumers can compare against join()-built ones.
  const gitDir = normalize(resolve(path, commonDir))
  return {
    repoRoot: dirname(gitDir),
    repoName: basename(dirname(gitDir)),
    branch: branchName === '' || branchName === 'HEAD' ? null : branchName,
    main: isMainWorktree(toplevel, gitDir),
  }
}

/** The one local-ignore rule the project-internal worktree layout needs.
 * Exactly this pattern — NOT `/.dsh/` — so project-level `.dsh/` files a user
 * may want to commit stay trackable. */
export const WORKTREE_EXCLUDE_RULE = '/.dsh/gitworktree/'

/** fs seams for {@link appendWorktreeExclude}; tests substitute. */
export interface ExcludeSeams {
  /** Whole file as UTF-8 text; a missing file reads as '' (the rule is
   * simply not there yet). */
  readFile: (path: string) => Promise<string>
  /** Append text to the end of the file, creating it when missing. */
  appendFile: (path: string, text: string) => Promise<void>
  /** Recursive mkdir for the `info` directory (git init ships it; a stripped
   * or hand-moved clone may not). */
  mkdir: (path: string) => Promise<void>
}

/** Real fs-backed seams. */
export const fsExcludeSeams: ExcludeSeams = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  },
  appendFile: async (path, text) => {
    await appendFile(path, text, 'utf8')
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
}

/**
 * Idempotently add {@link WORKTREE_EXCLUDE_RULE} to the repository's local
 * ignore file (`<repo>/.git/info/exclude`, reachable from every worktree
 * because it lives in the SHARED git dir): the git-blessed place for rules
 * that must stay private to this clone — never committed, never cloned.
 *
 * The write never blocks a worktree creation (the folder cannot be rolled
 * back once built), so a failure is returned as text for the response to
 * carry, not thrown. Idempotent by full-content line match: an absent rule
 * is appended behind a newline guard so it never glues onto the user's last
 * line; an existing rule — or any pre-existing content — is left untouched.
 * @param seams - fs seams (tests substitute).
 * @param repoRoot - the repository's main worktree directory.
 * @returns undefined on success (or the rule already being present); the
 * failure text otherwise.
 */
export async function appendWorktreeExclude(seams: ExcludeSeams, repoRoot: string): Promise<string | undefined> {
  try {
    const infoDir = join(repoRoot, '.git', 'info')
    const excludePath = join(infoDir, 'exclude')
    const text = await seams.readFile(excludePath)
    if (!text.split(/\r?\n/).includes(WORKTREE_EXCLUDE_RULE)) {
      await seams.mkdir(infoDir)
      const prefix = text === '' || text.endsWith('\n') ? '' : '\n'
      await seams.appendFile(excludePath, `${prefix}${WORKTREE_EXCLUDE_RULE}\n`)
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/* ------------------------------------------------------------------ *
 * Git panel (working tree, staging, commit, history, AI message).
 * Every panel command runs at the QUERIED checkout's own toplevel, so a
 * linked-worktree session reads and mutates its own worktree only.
 * ------------------------------------------------------------------ */

/** Working-tree facts of POST /changes. */
export interface WorkingChanges {
  /** One row per changed path, in `git status --porcelain` order. */
  changes: Array<{
    path: string
    oldPath?: string
    staged?: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
    unstaged?: 'A' | 'M' | 'D' | 'T' | 'U'
    untracked?: boolean
  }>
}

/** The XY pairs git reports as UNMERGED: until the path is re-staged, the
 * index holds conflict stages and neither column is a plain status. Such a
 * row surfaces as `unstaged: 'U'` (staging it resolves the conflict). */
const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * Parse one `git status --porcelain=v1 -z` byte stream into change rows.
 * NUL-separated so spaces and CJK in paths survive; a rename/copy entry is
 * followed by its ORIGINAL path as the next NUL field. XY columns: staged
 * (X) and unstaged (Y); `??` marks untracked; the unmerged pairs collapse
 * to a conflict row (`unstaged: 'U'`).
 */
export function parseStatusPorcelainZ(out: string): WorkingChanges['changes'] {
  const fields = out.split('\0')
  const changes: WorkingChanges['changes'] = []
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]
    if (entry === undefined || entry === '') continue
    const xy = entry.slice(0, 2)
    // XY columns, then exactly one space separator, then the path.
    const path = entry.slice(3)
    if (path === '') continue
    if (xy === '??') {
      changes.push({ path, untracked: true })
      continue
    }
    if (UNMERGED_XY.has(xy)) {
      changes.push({ path, unstaged: 'U' })
      continue
    }
    const row: WorkingChanges['changes'][number] = { path }
    const x = xy[0] ?? ' '
    const y = xy[1] ?? ' '
    if (x !== ' ' && x !== '?') {
      row.staged = x as NonNullable<WorkingChanges['changes'][number]['staged']>
    }
    if (y !== ' ' && y !== '?') {
      row.unstaged = y as NonNullable<WorkingChanges['changes'][number]['unstaged']>
    }
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // Rename/copy: the ORIGINAL path rides the next NUL field (new path first).
      const oldPath = fields[i + 1]
      i += 1
      if (oldPath !== undefined && oldPath !== '') row.oldPath = oldPath
    }
    if (row.staged !== undefined || row.unstaged !== undefined || row.untracked === true) changes.push(row)
  }
  return changes
}

/**
 * Working-tree changes of the queried checkout: `git status --porcelain=v1 -z`
 * with `core.quotepath=false` so CJK paths arrive unescaped.
 * @param exec - executor seam.
 * @param cwd - the checkout directory (worktree toplevel).
 */
export async function workingChanges(exec: Exec, cwd: string): Promise<WorkingChanges> {
  const out = await git(exec, cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z'])
  return { changes: parseStatusPorcelainZ(out) }
}

/** Guard for one (un)stage path: relative, no `..` escape, no drive root. */
export function isStageablePath(value: string): boolean {
  if (value === '' || value.length > 1024) return false
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false
  // An untracked DIRECTORY arrives collapsed as `dir/` — one trailing slash
  // is git's own shape and `git add` accepts it; only the trailing-slash
  // form is trimmed, an interior empty segment still refuses.
  const trimmed = value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value
  return trimmed.split('/').every(segment => segment !== '..' && segment !== '')
}

/**
 * Stage or unstage paths of the queried checkout. Staging is `git add`;
 * unstaging is `git reset -q HEAD --` which also answers the two tolerant
 * cases (an untracked path not in the index, an unborn HEAD) with a silent
 * success — both were smoke-verified.
 * @param exec - executor seam.
 * @param cwd - the checkout directory.
 * @param paths - relative paths (validated upstream via {@link isStageablePath}).
 * @param stage - true to stage, false to unstage.
 */
export async function stagePaths(exec: Exec, cwd: string, paths: readonly string[], stage: boolean): Promise<void> {
  if (paths.length === 0) return
  if (stage) {
    await git(exec, cwd, ['add', '--', ...paths])
    return
  }
  await git(exec, cwd, ['reset', '-q', 'HEAD', '--', ...paths])
}

/** Outcome of {@link commitIndex}. */
export interface CommitOutcome {
  hash: string
  subject: string
}

/**
 * Commit the index of the queried checkout (`git commit -m`). Hooks run as
 * usual; an empty index is git's own refusal and surfaces as a GitError.
 * @param exec - executor seam.
 * @param cwd - the checkout directory.
 * @param message - non-empty commit message (validated upstream).
 */
export async function commitIndex(exec: Exec, cwd: string, message: string): Promise<CommitOutcome> {
  await git(exec, cwd, ['commit', '-m', message])
  const hash = (await git(exec, cwd, ['rev-parse', 'HEAD'])).trim()
  const subject = message.split('\n')[0]?.trim() ?? ''
  return { hash, subject }
}

/** The pretty format one log record is parsed from: %x1f field split, %x1e record split. */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1f%D%x1e'

/** Parse `git log` output produced with {@link LOG_FORMAT}. */
export function parseLogOutput(out: string): CommitEntryRaw[] {
  const commits: CommitEntryRaw[] = []
  for (const record of out.split('\x1e')) {
    const text = record.startsWith('\n') ? record.slice(1) : record
    if (text.trim() === '') continue
    const f = text.split('\x1f')
    if (f.length < 9) continue
    const hash = f[0] ?? ''
    const short = f[1] ?? ''
    const dateRaw = f[4] ?? ''
    const parentsRaw = f[5] ?? ''
    const refsRaw = f[8] ?? ''
    if (hash === '' || short === '') continue
    const date = Date.parse(dateRaw)
    commits.push({
      hash,
      short,
      authorName: f[2] ?? '',
      authorEmail: f[3] ?? '',
      date: Number.isFinite(date) ? date : 0,
      parents: parentsRaw === '' ? [] : parentsRaw.split(' '),
      subject: f[6] ?? '',
      body: f[7] ?? '',
      refs: refsRaw === '' ? [] : refsRaw.split(', ').map(ref => ref.trim()).filter(ref => ref !== ''),
    })
  }
  return commits
}

/** One parsed log row, before any client shaping. */
export interface CommitEntryRaw {
  hash: string
  short: string
  authorName: string
  authorEmail: string
  date: number
  parents: string[]
  subject: string
  body: string
  refs: string[]
}

/** The extra log filters the history card's toolbar drives. */
export interface LogFilter {
  /** Every ref (local + remote branches, tags) instead of the checkout's
   * HEAD — the history card's default view. Ignored when `ref` is given. */
  all?: boolean
  /** Committer-author substring/regex, forwarded as `--author=<value>`. */
  author?: string
  /** Lower/upper bound on the commit date, epoch milliseconds. */
  since?: number
  until?: number
}

/**
 * Paginated history of the queried checkout. `ref` is verified with
 * `rev-parse --verify` first, so an arbitrary string can never reach the log
 * arguments as anything but a resolvable rev. An unborn checkout (no commits
 * yet) answers an empty page instead of an error.
 *
 * `--topo-order` is unconditional: the history card draws lane lines from
 * `parents`, and a pure date order would interleave a branch's commits
 * before their merge base, leaving edges pointing at rows not yet painted.
 * @param exec - executor seam.
 * @param cwd - the checkout directory.
 * @param limit - page size (1..200, validated upstream).
 * @param skip - offset (>= 0, validated upstream).
 * @param ref - optional starting rev; absent = the checkout's HEAD.
 * @param filter - optional all-refs/author/date window.
 */
export async function logHistory(exec: Exec, cwd: string, limit: number, skip: number, ref?: string, filter?: LogFilter): Promise<CommitEntryRaw[]> {
  let start: string | undefined
  if (ref !== undefined && ref !== '' && ref !== 'HEAD') {
    const verified = await gitMaybe(exec, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (verified === undefined || verified.trim() === '') {
      throw new GitError(['log'], 1, `unknown revision "${ref}"`)
    }
    start = verified.trim()
  }
  // A ref narrows the walk to that ref's ancestry; `--all` is only the
  // no-ref default. Combining them would list every branch under a
  // "this branch" filter.
  const all = filter?.all === true && start === undefined
  const author = filter?.author?.trim() ?? ''
  const since = filter?.since
  const until = filter?.until
  try {
    const out = await git(exec, cwd, [
      'log', `--max-count=${String(limit)}`, `--skip=${String(skip)}`, '--topo-order',
      '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`,
      ...(all ? ['--all'] : []),
      ...(author === '' ? [] : [`--author=${author}`]),
      ...(since === undefined ? [] : [`--since=${new Date(since).toISOString()}`]),
      ...(until === undefined ? [] : [`--until=${new Date(until).toISOString()}`]),
      ...(start === undefined ? [] : [start]),
    ])
    return parseLogOutput(out)
  } catch (error) {
    // An unborn checkout refuses `git log` with exit 128; the stderr TEXT is
    // locale-dependent, so confirm by asking HEAD directly instead of
    // matching the message. An existing HEAD means a real failure — rethrow.
    if (error instanceof GitError && error.code === 128
      && await gitMaybe(exec, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']) === undefined) return []
    throw error
  }
}

/** One file row of {@link commitFiles}. */
export interface CommitFileRow {
  path: string
  oldPath?: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  insertions?: number
  deletions?: number
  binary?: boolean
}

/**
 * Parse one `git diff --name-status -M` output block (tabs between fields).
 * R/C rows carry `score\told\tnew`; plain rows `status\tpath`.
 */
export function parseNameStatus(out: string): Array<{ path: string; oldPath?: string; status: CommitFileRow['status'] }> {
  const rows: Array<{ path: string; oldPath?: string; status: CommitFileRow['status'] }> = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    const head = parts[0] ?? ''
    const letter = head[0] ?? ''
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[1] ?? ''
      const path = parts[2] ?? ''
      if (path === '') continue
      rows.push(oldPath === '' ? { path, status: letter } : { path, oldPath, status: letter })
      continue
    }
    const path = parts[1] ?? ''
    if (path === '') continue
    if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T') {
      rows.push({ path, status: letter })
    }
  }
  return rows
}

/**
 * Parse one `git diff --numstat -M` output block: `ins\tdel\tpath`, `-` for a
 * binary file's counts. Only the COUNTS are consumed — paths (whose rename
 * form `old => new` / `prefix{old => new}suffix` is ambiguous) come from the
 * aligned name-status block instead.
 */
export function parseNumstatCounts(out: string): Array<{ insertions: number | undefined; deletions: number | undefined }> {
  return out.split('\n').filter(line => line.trim() !== '').map(line => {
    const parts = line.split('\t')
    const ins = parts[0] ?? '-'
    const del = parts[1] ?? '-'
    const insertions = ins === '-' || !/^\d+$/.test(ins) ? undefined : Number(ins)
    const deletions = del === '-' || !/^\d+$/.test(del) ? undefined : Number(del)
    return { insertions, deletions }
  })
}

/**
 * The files one commit changed, of the queried checkout. The hash is
 * verified with `rev-parse --verify` first; status comes from
 * `--name-status -M`, the +/- line counts from the index-aligned
 * `--numstat -M` block.
 * @param exec - executor seam.
 * @param cwd - the checkout directory.
 * @param hash - the commit hash (validated upstream, verified here).
 */
export async function commitFiles(exec: Exec, cwd: string, hash: string): Promise<CommitFileRow[]> {
  const verified = await gitMaybe(exec, cwd, ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`])
  if (verified === undefined || verified.trim() === '') {
    throw new GitError(['show'], 1, `unknown revision "${hash}"`)
  }
  const resolved = verified.trim()
  const [statusOut, numstatOut] = await Promise.all([
    git(exec, cwd, ['-c', 'core.quotepath=false', 'show', '--name-status', '-M', '--format=', resolved]),
    git(exec, cwd, ['-c', 'core.quotepath=false', 'show', '--numstat', '-M', '--format=', resolved]),
  ])
  const rows = parseNameStatus(statusOut)
  const counts = parseNumstatCounts(numstatOut)
  return rows.map((row, index) => {
    const count = counts[index]
    const binary = count !== undefined && (count.insertions === undefined || count.deletions === undefined)
    return {
      ...row,
      ...(count !== undefined && !binary && count.insertions !== undefined ? { insertions: count.insertions } : {}),
      ...(count !== undefined && !binary && count.deletions !== undefined ? { deletions: count.deletions } : {}),
      ...(binary ? { binary: true } : {}),
    }
  })
}

/** Cap for the diff text handed to the AI route (characters). */
export const AI_DIFF_CAP = 12_000

/**
 * The diff text the AI commit-message route sees: the staged diff when the
 * index is non-empty, otherwise the unstaged diff plus untracked paths —
 * an AI message for nothing staged should describe what WOULD be committed.
 * Truncated to {@link AI_DIFF_CAP} characters; also collects the last
 * subjects so the model can follow the repository's own style.
 * @param exec - executor seam.
 * @param cwd - the checkout directory.
 */
export async function collectAiDiff(exec: Exec, cwd: string): Promise<{ diff: string; recentSubjects: string[]; staged: boolean }> {
  const stagedDiff = await gitMaybe(exec, cwd, ['-c', 'core.quotepath=false', 'diff', '--cached'])
  let staged = true
  let diff = stagedDiff ?? ''
  if (diff.trim() === '') {
    staged = false
    const unstaged = await gitMaybe(exec, cwd, ['-c', 'core.quotepath=false', 'diff'])
    const untracked = await workingChanges(exec, cwd)
    const names = untracked.changes.filter(row => row.untracked).map(row => row.path)
    diff = `${unstaged ?? ''}${names.length > 0 ? `\n${names.map(name => `Untracked file: ${name}`).join('\n')}` : ''}`
  }
  if (diff.length > AI_DIFF_CAP) diff = `${diff.slice(0, AI_DIFF_CAP)}\n…(diff truncated)`
  const recent = await gitMaybe(exec, cwd, ['log', '--max-count=10', '--pretty=format:%s'])
  return {
    diff,
    recentSubjects: (recent ?? '').split('\n').map(line => line.trim()).filter(line => line !== ''),
    staged,
  }
}
