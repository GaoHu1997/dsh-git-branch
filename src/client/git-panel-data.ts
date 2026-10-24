/**
 * Pure helpers behind the Git panel: ref-badge classification, history and
 * branch filtering, and the page state machine for "load more". No React, no I/O —
 * everything is a plain function of its arguments so the tests can exercise
 * the exact logic the components render.
 */

import type { CommitEntry, WorktreeChange } from '../wire.ts'

/** One classified ref of a commit, driving the badge color. */
export interface CommitRefBadge {
  kind: 'head' | 'tag' | 'remote' | 'local'
  text: string
}

/**
 * Classify raw %D decoration segments: `HEAD -> main` (and bare `HEAD`) is
 * the head badge, `tag: x` a tag, anything containing `/` a remote branch,
 * the rest a local branch.
 */
export function classifyRefs(refs: readonly string[]): CommitRefBadge[] {
  const badges: CommitRefBadge[] = []
  for (const ref of refs) {
    if (ref === 'HEAD' || ref.startsWith('HEAD -> ')) {
      badges.push({ kind: 'head', text: ref })
      continue
    }
    if (ref.startsWith('tag: ')) {
      badges.push({ kind: 'tag', text: ref.slice('tag: '.length) })
      continue
    }
    if (ref.includes('/')) {
      badges.push({ kind: 'remote', text: ref })
      continue
    }
    badges.push({ kind: 'local', text: ref })
  }
  return badges
}

/** A staged/unstaged view row derived from one working-tree change. */
export interface ChangeRow {
  path: string
  oldPath?: string
  /** Status letter to render ('?' for untracked, 'U' for an unmerged conflict). */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'
  /** True once the path sits in the index. */
  staged: boolean
}

/**
 * Split the working-tree rows into the two panel groups. Untracked files
 * render in the unstaged group as `?` (git add still stages them); an
 * unmerged conflict renders in the unstaged group as `U` unchecked (git add
 * resolves it); a rename's checkbox toggles BOTH paths (unstage needs the
 * old path).
 */
export function groupChanges(changes: readonly WorktreeChange[]): { staged: ChangeRow[]; unstaged: ChangeRow[] } {
  const staged: ChangeRow[] = []
  const unstaged: ChangeRow[] = []
  for (const change of changes) {
    if (change.untracked === true) {
      unstaged.push({ path: change.path, status: '?', staged: false })
      continue
    }
    if (change.staged !== undefined) {
      staged.push({
        path: change.path,
        ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
        status: change.staged,
        staged: true,
      })
    }
    if (change.unstaged !== undefined) {
      unstaged.push({
        path: change.path,
        ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
        status: change.unstaged,
        staged: false,
      })
    }
  }
  return { staged, unstaged }
}

/** Subject-case-insensitive filter over the commit subject and author. */
export function filterCommits(commits: readonly CommitEntry[], query: string): CommitEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...commits]
  return commits.filter(commit =>
    commit.subject.toLowerCase().includes(needle) || commit.authorName.toLowerCase().includes(needle))
}

/**
 * Case-insensitive substring filter over the branch name — the branch card's
 * head search box. A remote row matches on its full `remote/name`, which
 * contains the prefix-stripped short name the tree renders, so searching what
 * the user sees and searching the remote prefix both hit.
 */
export function filterBranches(rows: readonly BranchRow[], query: string): BranchRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter(row => row.name.toLowerCase().includes(needle))
}

/** Merge the next page into the accumulated list, dropping hash duplicates
 * (a ref moved between fetches must not duplicate rows). */
export function appendPage(current: readonly CommitEntry[], page: readonly CommitEntry[]): CommitEntry[] {
  const seen = new Set(current.map(commit => commit.hash))
  const merged = [...current]
  for (const commit of page) {
    if (seen.has(commit.hash)) continue
    seen.add(commit.hash)
    merged.push(commit)
  }
  return merged
}

/** One branch row the panel renders, split for the two groups. */
export interface BranchRow {
  name: string
  kind: 'local' | 'remote'
  ahead?: number
  behind?: number
  current: boolean
}

/** Build the branch rows from a RepoStatus: locals first (current first),
 * then remote-only branches, sorted by name. */
export function buildBranchRows(
  branches: ReadonlyArray<{ name: string; kind: 'local' | 'remote'; ahead?: number; behind?: number }>,
  currentBranch: string,
): { locals: BranchRow[]; remotes: BranchRow[] } {
  const locals: BranchRow[] = []
  const remotes: BranchRow[] = []
  for (const branch of branches) {
    const row: BranchRow = {
      name: branch.name,
      kind: branch.kind,
      current: branch.kind === 'local' && branch.name === currentBranch,
      ...(branch.ahead !== undefined ? { ahead: branch.ahead } : {}),
      ...(branch.behind !== undefined ? { behind: branch.behind } : {}),
    }
    if (branch.kind === 'local') locals.push(row)
    else remotes.push(row)
  }
  const byName = (left: BranchRow, right: BranchRow): number => left.name.localeCompare(right.name)
  locals.sort((left, right) => Number(right.current) - Number(left.current) || byName(left, right))
  remotes.sort(byName)
  return { locals, remotes }
}

/** One remote subtree of the branch tree: the remote's own name plus its
 * branches with the `<remote>/` prefix stripped. */
export interface RemoteGroup {
  remote: string
  branches: Array<BranchRow & { short: string }>
}

/**
 * Nest remote-only branches under their remote (`origin/feat/x` lands in
 * the `origin` subtree as `feat/x`) — the IDEA-style two-level 远程 tree.
 * A bare ref directly under refs/remotes (no `/`) is skipped: the branch
 * list never offers it.
 */
export function groupRemotes(remotes: readonly BranchRow[]): RemoteGroup[] {
  const groups = new Map<string, RemoteGroup['branches']>()
  for (const row of remotes) {
    const slash = row.name.indexOf('/')
    if (slash <= 0 || slash === row.name.length - 1) continue
    const remote = row.name.slice(0, slash)
    const short = row.name.slice(slash + 1)
    const list = groups.get(remote) ?? []
    list.push({ ...row, short })
    groups.set(remote, list)
  }
  return [...groups.entries()]
    .map(([remote, branches]) => ({ remote, branches }))
    .sort((left, right) => left.remote.localeCompare(right.remote))
}

/** Every group key the branch tree renders — the collapse-all target set.
 * The bare `remote` key folds the whole remote tree; the nested
 * `remote:<name>` keys matter only for the groups it re-opens. */
export function branchGroupKeys(remotes: readonly BranchRow[]): string[] {
  return ['local', 'remote', ...groupRemotes(remotes).map(group => `remote:${group.remote}`)]
}
