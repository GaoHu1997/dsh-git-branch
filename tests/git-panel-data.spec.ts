/**
 * Git-panel data tests: the client-side pure helpers (group splitting with
 * conflict rows, history and branch filtering) that the three sections render.
 */

import { describe, expect, it } from 'vitest'
import { branchGroupKeys, filterBranches, filterCommits, groupChanges, groupRemotes } from '../src/client/git-panel-data.ts'
import type { CommitEntry, WorktreeChange } from '../src/wire.ts'

describe('groupChanges', () => {
  it('splits staged and unstaged rows and maps untracked to ?', () => {
    const { staged, unstaged } = groupChanges([
      { path: 'a.ts', staged: 'M', unstaged: 'M' },
      { path: 'b.ts', unstaged: 'D' },
      { path: 'c.md', untracked: true },
    ])
    expect(staged).toEqual([{ path: 'a.ts', status: 'M', staged: true }])
    expect(unstaged).toEqual([
      { path: 'a.ts', status: 'M', staged: false },
      { path: 'b.ts', status: 'D', staged: false },
      { path: 'c.md', status: '?', staged: false },
    ])
  })

  it('renders an unmerged conflict row in the unstaged group, unchecked', () => {
    const { staged, unstaged } = groupChanges([{ path: 'c.txt', unstaged: 'U' }])
    expect(staged).toEqual([])
    expect(unstaged).toEqual([{ path: 'c.txt', status: 'U', staged: false }])
  })

  it('keeps a rename row on both paths (toggle needs the old path)', () => {
    const { staged } = groupChanges([{ path: 'new.txt', oldPath: 'old.txt', staged: 'R' }])
    expect(staged).toEqual([{ path: 'new.txt', oldPath: 'old.txt', status: 'R', staged: true }])
  })
})

describe('filterCommits', () => {
  const commit = (hash: string, subject: string, authorName: string): CommitEntry => ({
    hash, short: hash.slice(0, 7), authorName, authorEmail: `${authorName}@x`, date: 0, parents: [], subject, body: '', refs: [],
  })
  const commits = [commit('a1', 'feat: 面板', 'Gao'), commit('b2', 'fix: chip', 'Lin')]

  it('matches subject and author case-insensitively', () => {
    expect(filterCommits(commits, '面板')).toEqual([commits[0]])
    expect(filterCommits(commits, 'GAO')).toEqual([commits[0]])
    expect(filterCommits(commits, 'chip')).toEqual([commits[1]])
  })

  it('returns every commit for a blank query', () => {
    expect(filterCommits(commits, '  ')).toEqual(commits)
  })
})

describe('filterBranches', () => {
  const rows = [
    { name: 'main', kind: 'local', current: true },
    { name: 'feat/git-panel', kind: 'local', current: false },
    { name: 'origin/feat/git-panel', kind: 'remote', current: false },
    { name: 'origin/main', kind: 'remote', current: false },
  ] as const

  it('matches the branch name case-insensitively, remote rows by full name', () => {
    expect(filterBranches(rows, 'git-panel').map(row => row.name)).toEqual(['feat/git-panel', 'origin/feat/git-panel'])
    expect(filterBranches(rows, 'MAIN').map(row => row.name)).toEqual(['main', 'origin/main'])
    // The remote prefix is part of the full name, so it is searchable too.
    expect(filterBranches(rows, 'origin/').map(row => row.name)).toEqual(['origin/feat/git-panel', 'origin/main'])
  })

  it('returns every row for a blank query', () => {
    expect(filterBranches(rows, '  ')).toEqual([...rows])
  })

  it('matches nothing when no name contains the needle', () => {
    expect(filterBranches(rows, 'release')).toEqual([])
  })
})

describe('groupRemotes', () => {
  it('nests remote branches under their remote with the prefix stripped', () => {
    const groups = groupRemotes([
      { name: 'origin/main', kind: 'remote', current: false },
      { name: 'origin/feat/git-panel', kind: 'remote', current: false },
      { name: 'upstream/main', kind: 'remote', current: false },
    ])
    expect(groups).toEqual([
      { remote: 'origin', branches: [
        { name: 'origin/main', kind: 'remote', current: false, short: 'main' },
        { name: 'origin/feat/git-panel', kind: 'remote', current: false, short: 'feat/git-panel' },
      ] },
      { remote: 'upstream', branches: [
        { name: 'upstream/main', kind: 'remote', current: false, short: 'main' },
      ] },
    ])
  })

  it('sorts remotes by name and skips bare remote refs without a slash', () => {
    const groups = groupRemotes([
      { name: 'upstream/main', kind: 'remote', current: false },
      { name: 'origin/dev', kind: 'remote', current: false },
      { name: 'origin', kind: 'remote', current: false },
    ])
    expect(groups.map(group => group.remote)).toEqual(['origin', 'upstream'])
  })
})

describe('branchGroupKeys', () => {
  it('lists every group key the tree renders, nested remotes prefixed', () => {
    expect(branchGroupKeys([
      { name: 'origin/main', kind: 'remote', current: false },
      { name: 'upstream/dev', kind: 'remote', current: false },
    ])).toEqual(['local', 'remote', 'remote:origin', 'remote:upstream'])
  })

  it('degrades to the two root groups without remotes', () => {
    expect(branchGroupKeys([])).toEqual(['local', 'remote'])
  })
})
