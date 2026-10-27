import { describe, expect, it } from 'vitest'
import { join, normalize, resolve } from 'node:path'
import {
  accelArgs, addWorktree, addWorktreeCutout, appendWorktreeExclude, createBranch, cutoutBranchName, deleteBranch, fetchAll, inspectWorktree, listTagNames, NETWORK_TIMEOUT_MS, probeRepo, probeWorkspaceGit, pushBranch, pushTag, removeWorktree, renameBranch, resolvePushRemote, switchBranch, updateBranch, WORKTREE_EXCLUDE_RULE,
  type ExcludeSeams, type Exec, type ExecResult,
} from '../src/git.ts'

/** Platform-correct expectation for a scripted POSIX-shaped path. */
const p = (value: string): string => normalize(value)

/**
 * Scripted executor: each entry is tested in order against the argument list
 * (a prefix match), answering the scripted result; an unmatched call fails
 * the test so argument drift cannot pass silently.
 */
function scripted(calls: readonly { args: readonly string[]; out: Partial<ExecResult> }[]): Exec {
  let at = 0
  return async (_file, args) => {
    const entry = calls[at]
    at += 1
    if (entry === undefined) throw new Error(`unexpected git call #${at}: git ${args.join(' ')}`)
    const matches = entry.args.length <= args.length
      && entry.args.every((want, i) => want === args[i])
    if (!matches) throw new Error(`git call #${at} wanted [${entry.args.join(' ')}] got [${args.join(' ')}]`)
    return { code: 0, stdout: '', stderr: '', ...entry.out }
  }
}

/** Porcelain listing for two worktrees: main on main, linked on feat-x. */
const TWO_WORKTREES = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /root/repo/feat-x',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feat-x',
  '',
].join('\n')

/** Porcelain after the linked worktree has been unregistered. */
const MAIN_ONLY = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
].join('\n')

describe('probeRepo', () => {
  it('assembles facts from rev-parse, branch refs, and worktree porcelain', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--show-toplevel'], out: { stdout: '/repo\n' } },
      { args: ['rev-parse', '--git-common-dir'], out: { stdout: '/repo/.git\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'main\n' } },
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main[ahead 1, behind 2]\nfeat-x\n' } },
      { args: ['for-each-ref', 'refs/remotes'], out: { stdout: 'origin/HEAD\norigin/main\norigin/dev\nupstream/dev\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    const facts = await probeRepo(exec, '/repo/sub', () => true)
    expect(facts).toBeDefined()
    expect(facts?.repoName).toBe('repo')
    expect(facts?.currentBranch).toBe('main')
    // The queried directory IS the main checkout: its toplevel holds the
    // shared .git the common dir names.
    expect(facts?.toplevel).toBe(p('/repo'))
    expect(facts?.main).toBe(true)
    // Every remote's remote-only branches come through: `<remote>/HEAD` and
    // branches with a local twin (origin/main) drop, the rest keep their
    // remote prefix — origin and upstream side by side, no first-remote fold.
    // Local rows carry their upstream track: main diverges, feat-x (no
    // upstream) gets no counts.
    expect(facts?.branches).toEqual([
      { name: 'main', kind: 'local', ahead: 1, behind: 2 },
      { name: 'feat-x', kind: 'local' },
      { name: 'origin/dev', kind: 'remote' },
      { name: 'upstream/dev', kind: 'remote' },
    ])
    // The FULL remote view keeps the local twin (origin/main): the git
    // panel's remote tree lists every remote branch.
    expect(facts?.remoteBranches).toEqual([
      { name: 'origin/main', kind: 'remote' },
      { name: 'origin/dev', kind: 'remote' },
      { name: 'upstream/dev', kind: 'remote' },
    ])
    expect(facts?.worktrees).toEqual([
      { path: p('/repo'), branch: 'main', main: true },
      { path: p('/root/repo/feat-x'), branch: 'feat-x', main: false },
    ])
  })

  it('reports undefined outside a repository', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--show-toplevel'], out: { code: 128, stderr: 'fatal: not a git repository\n' } },
    ])
    expect(await probeRepo(exec, '/plain', () => true)).toBeUndefined()
  })

  it('names the repository from the common dir inside a linked worktree', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--show-toplevel'], out: { stdout: '/root/repo/feat-x\n' } },
      { args: ['rev-parse', '--git-common-dir'], out: { stdout: '/root/repo/.git\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'feat-x\n' } },
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\nfeat-x\n' } },
      { args: ['for-each-ref', 'refs/remotes'], out: { code: 0, stdout: '' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    const facts = await probeRepo(exec, '/root/repo/feat-x/src', () => true)
    expect(facts?.repoRoot).toBe(resolve('/root/repo'))
    expect(facts?.repoName).toBe('repo')
    expect(facts?.currentBranch).toBe('feat-x')
    // Still rooted at the main checkout for repository-wide work, but the
    // queried directory is NOT it: its own toplevel is the linked folder, so
    // `main` is false and `toplevel` names the linked worktree. This is the
    // pair the session-scope trigger reads — comparing `repoRoot` against the
    // main worktree entry can only ever answer true.
    expect(facts?.toplevel).toBe(p('/root/repo/feat-x'))
    expect(facts?.main).toBe(false)
  })

  it('marks a detached worktree branchless', async () => {
    const porcelain = ['worktree /repo', 'HEAD 111', 'branch refs/heads/main', '', 'worktree /wt', 'HEAD 222', 'detached', ''].join('\n')
    const exec = scripted([
      { args: ['rev-parse', '--show-toplevel'], out: { stdout: '/repo\n' } },
      { args: ['rev-parse', '--git-common-dir'], out: { stdout: '/repo/.git\n' } },
      { args: ['branch', '--show-current'], out: { stdout: '' } },
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
      { args: ['for-each-ref', 'refs/remotes'], out: { code: 0, stdout: '' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: porcelain } },
    ])
    const facts = await probeRepo(exec, '/repo', () => true)
    expect(facts?.currentBranch).toBe('HEAD')
    expect(facts?.worktrees[1]).toEqual({ path: p('/wt'), branch: undefined, main: false })
  })

  it('drops gone and in-sync upstream tracks, keeps behind-only counts', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--show-toplevel'], out: { stdout: '/repo\n' } },
      { args: ['rev-parse', '--git-common-dir'], out: { stdout: '/repo/.git\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'main\n' } },
      // `[gone]` (upstream deleted server-side) carries no counts and must
      // not surface as NaN-ish garbage; an in-sync branch has no bracket.
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main[behind 3]\ndev[gone]\nsync\n' } },
      { args: ['for-each-ref', 'refs/remotes'], out: { code: 0, stdout: '' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    const facts = await probeRepo(exec, '/repo', () => true)
    expect(facts?.branches).toEqual([
      { name: 'main', kind: 'local', behind: 3 },
      { name: 'dev', kind: 'local' },
      { name: 'sync', kind: 'local' },
    ])
    expect(facts?.remoteBranches).toEqual([])
  })

  it('skips the bare leftover ref under refs/remotes (no slash below it)', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--show-toplevel'], out: { stdout: '/repo\n' } },
      { args: ['rev-parse', '--git-common-dir'], out: { stdout: '/repo/.git\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'main\n' } },
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
      // `refs/remotes/origin` (shortname `origin`, no `/`) is a leftover
      // ref, not a remote branch — git branch -r hides it, so must the list.
      // origin/main also hides: its local twin `main` exists.
      { args: ['for-each-ref', 'refs/remotes'], out: { stdout: 'origin\norigin/main\norigin/dev\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    const facts = await probeRepo(exec, '/repo', () => true)
    expect(facts?.branches).toEqual([
      { name: 'main', kind: 'local' },
      { name: 'origin/dev', kind: 'remote' },
    ])
    expect(facts?.remoteBranches).toEqual([
      { name: 'origin/main', kind: 'remote' },
      { name: 'origin/dev', kind: 'remote' },
    ])
  })
})

describe('addWorktree', () => {
  it('reuses the existing worktree for the branch without running add', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\nfeat-x\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    const result = await addWorktree(exec, '/repo', 'feat-x', '/root/repo/feat-x-2', () => true)
    expect(result).toEqual({ path: p('/root/repo/feat-x'), created: false })
  })

  it('adds a local branch when it exists locally', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\ndev\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: 'worktree /repo\nHEAD 1\nbranch refs/heads/main\n' } },
      { args: ['worktree', 'add', '/root/repo/dev', 'dev'] },
    ])
    const result = await addWorktree(exec, '/repo', 'dev', '/root/repo/dev', () => true)
    expect(result).toEqual({ path: '/root/repo/dev', created: true })
  })

  it('creates a local twin for a remote-only branch', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
      { args: ['for-each-ref', 'refs/remotes', 'refs/remotes/origin/dev'], out: { stdout: 'origin/dev\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: 'worktree /repo\nHEAD 1\nbranch refs/heads/main\n' } },
      { args: ['worktree', 'add', '/root/repo/dev', '-b', 'dev', 'origin/dev'] },
    ])
    const result = await addWorktree(exec, '/repo', 'origin/dev', '/root/repo/dev', () => true)
    expect(result).toEqual({ path: '/root/repo/dev', created: true })
  })

  it('rejects an unknown branch', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
      { args: ['for-each-ref', 'refs/remotes', 'refs/remotes/nope'], out: { code: 0, stdout: '' } },
    ])
    await expect(addWorktree(exec, '/repo', 'nope', '/root/repo/nope', () => true)).rejects.toThrow('branch "nope" not found')
  })
})

describe('cutoutBranchName', () => {
  it('names the cutout branch <base>-wt when free', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\ndev\n' } },
    ])
    expect(await cutoutBranchName(exec, '/repo', 'main')).toBe('main-wt')
  })

  it('suffixes -wt<N> past taken names', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\nmain-wt\nmain-wt2\n' } },
    ])
    expect(await cutoutBranchName(exec, '/repo', 'main')).toBe('main-wt3')
  })

  it('passes a slashed local name and detached HEAD through verbatim', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'feature/x\n' } },
    ])
    expect(await cutoutBranchName(exec, '/repo', 'feature/x')).toBe('feature/x-wt')
    const detached = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
    ])
    expect(await cutoutBranchName(detached, '/repo', 'HEAD')).toBe('HEAD-wt')
  })

  it('skips a name whose storage folder is taken though the branch is free', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
    ])
    // A branch deleted by hand leaves its folder behind: `main-wt` must not
    // be planned again, or `worktree add` fails on the existing directory.
    expect(await cutoutBranchName(exec, '/repo', 'main', name => name === 'main-wt')).toBe('main-wt2')
  })

  it('keeps the stem when branch and folder are both free', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
    ])
    expect(await cutoutBranchName(exec, '/repo', 'main', () => false)).toBe('main-wt')
  })
})

describe('addWorktreeCutout', () => {
  it('adds the new branch out of the base into the target', async () => {
    const exec = scripted([
      { args: ['worktree', 'add', '/root/repo/main-wt', '-b', 'main-wt', 'main'] },
    ])
    await expect(addWorktreeCutout(exec, '/repo', 'main', 'main-wt', '/root/repo/main-wt')).resolves.toBeUndefined()
  })

  it('surfaces a git refusal of the base branch', async () => {
    const exec = scripted([
      { args: ['worktree', 'add', '/root/repo/main-wt', '-b', 'main-wt', 'main'],
        out: { code: 128, stderr: 'fatal: invalid reference: main\n' } },
    ])
    await expect(addWorktreeCutout(exec, '/repo', 'main', 'main-wt', '/root/repo/main-wt')).rejects.toThrow('fatal')
  })
})

describe('switchBranch', () => {
  it('switches by local name', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\ndev\n' } },
      { args: ['switch', 'dev'] },
    ])
    expect(await switchBranch(exec, '/repo', 'dev')).toBe('dev')
  })

  it('switches a remote-only branch through the dwim name', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/heads'], out: { stdout: 'main\n' } },
      { args: ['for-each-ref', 'refs/remotes', 'refs/remotes/origin/dev'], out: { stdout: 'origin/dev\n' } },
      { args: ['switch', 'dev'] },
    ])
    expect(await switchBranch(exec, '/repo', 'origin/dev')).toBe('dev')
  })
})

describe('createBranch', () => {
  it('runs switch -c at the queried directory and reports the name', async () => {
    const exec = scripted([
      { args: ['switch', '-c', 'feat/auth-login'], out: { stdout: "Switched to a new branch 'feat/auth-login'\n" } },
    ])
    expect(await createBranch(exec, '/repo/wt', 'feat/auth-login')).toBe('feat/auth-login')
  })

  it('creates at an explicit start point without moving the checkout', async () => {
    const exec = scripted([
      { args: ['branch', 'dev', 'origin/main'], out: { stdout: '' } },
    ])
    expect(await createBranch(exec, '/repo', 'dev', 'origin/main')).toBe('dev')
  })

  it('creates at a start point and checks it out in one stroke when checkout is set', async () => {
    const exec = scripted([
      { args: ['switch', '-c', 'dev', 'origin/main'], out: { stdout: "Switched to a new branch 'dev'\n" } },
    ])
    expect(await createBranch(exec, '/repo', 'dev', 'origin/main', true)).toBe('dev')
  })

  it('surfaces a git refusal of the name', async () => {
    const exec = scripted([
      { args: ['switch', '-c', 'bad..name'],
        out: { code: 128, stderr: "fatal: 'bad..name' is not a valid branch name\n" } },
    ])
    await expect(createBranch(exec, '/repo', 'bad..name')).rejects.toThrow('not a valid branch name')
  })
})

describe('renameBranch', () => {
  it('runs branch -m at the repository root and reports the new name', async () => {
    const exec = scripted([
      { args: ['branch', '-m', 'feat/x', 'feat/y'], out: { stdout: '' } },
    ])
    expect(await renameBranch(exec, '/repo', 'feat/x', 'feat/y')).toBe('feat/y')
  })

  it('surfaces a git refusal of the new name', async () => {
    const exec = scripted([
      { args: ['branch', '-m', 'feat/x', 'bad..name'],
        out: { code: 128, stderr: "fatal: 'bad..name' is not a valid branch name\n" } },
    ])
    await expect(renameBranch(exec, '/repo', 'feat/x', 'bad..name')).rejects.toThrow('not a valid branch name')
  })
})

describe('deleteBranch', () => {
  it('runs the SAFE -d form at the repository root and reports the name', async () => {
    const exec = scripted([
      { args: ['branch', '-d', 'feat/x'], out: { stdout: "Deleted branch feat/x (was abc123).\n" } },
    ])
    expect(await deleteBranch(exec, '/repo', 'feat/x')).toBe('feat/x')
  })

  it('surfaces git deletion refusals (unmerged, occupied)', async () => {
    const exec = scripted([
      { args: ['branch', '-d', 'feat/x'],
        out: { code: 1, stderr: "error: the branch 'feat/x' is not fully merged.\n" } },
    ])
    await expect(deleteBranch(exec, '/repo', 'feat/x')).rejects.toThrow('not fully merged')
  })
})

describe('accelArgs', () => {
  const REWRITE = '-c'
  const REWRITE_VALUE = 'url.https://gh-proxy.com/.insteadOf=https://github.com/'

  it('emits the per-command rewrite with a normalized prefix', () => {
    expect(accelArgs('https://gh-proxy.com/')).toEqual([REWRITE, REWRITE_VALUE])
    // The prefix arrives un-normalized and gains the trailing slash.
    expect(accelArgs('https://gh-proxy.com')).toEqual([REWRITE, REWRITE_VALUE])
    expect(accelArgs('  https://mirror.example/prefix  ')).toEqual([REWRITE, 'url.https://mirror.example/prefix/.insteadOf=https://github.com/'])
  })

  it('stays empty without a prefix (the switch is off)', () => {
    expect(accelArgs(undefined)).toEqual([])
  })

  it('fails safe to no rewrite when the prefix is not a usable URL', () => {
    expect(accelArgs('gh-proxy.com')).toEqual([])
    expect(accelArgs('ftp://mirror.example/')).toEqual([])
    expect(accelArgs('https://mirror.example/a b')).toEqual([])
    expect(accelArgs('')).toEqual([])
  })
})

describe('fetchAll', () => {
  it('fetches every remote with prune at the repository root', async () => {
    const exec = scripted([
      { args: ['fetch', '--all', '--prune'], out: { stdout: 'Fetching origin\n' } },
    ])
    await expect(fetchAll(exec, '/repo')).resolves.toBeUndefined()
  })

  it('puts the mirror rewrite in front of the fetch when the prefix is set', async () => {
    const exec = scripted([
      { args: ['-c', 'url.https://gh-proxy.com/.insteadOf=https://github.com/', 'fetch', '--all', '--prune'], out: {} },
    ])
    await expect(fetchAll(exec, '/repo', 'https://gh-proxy.com')).resolves.toBeUndefined()
  })

  it('stays a bare fetch without a prefix or with an unusable one', async () => {
    const bare = scripted([
      { args: ['fetch', '--all', '--prune'], out: {} },
    ])
    await expect(fetchAll(bare, '/repo', undefined)).resolves.toBeUndefined()
    const unusable = scripted([
      { args: ['fetch', '--all', '--prune'], out: {} },
    ])
    await expect(fetchAll(unusable, '/repo', 'gh-proxy.com')).resolves.toBeUndefined()
  })

  it('surfaces a network refusal', async () => {
    const exec = scripted([
      { args: ['fetch', '--all', '--prune'],
        out: { code: 128, stderr: 'fatal: unable to access \'https://example.com/repo.git\': Could not resolve host\n' } },
    ])
    await expect(fetchAll(exec, '/repo')).rejects.toThrow('Could not resolve host')
  })
})

describe('updateBranch', () => {
  it('fetches then fast-forwards HEAD to the upstream', async () => {
    const exec = scripted([
      { args: ['fetch', '--all', '--prune'] },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'aaa111\n' } },
      { args: ['merge', '--ff-only', '@{u}'], out: { stdout: 'Updating aaa111..bbb222\nFast-forward\n' } },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'bbb222\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'main\n' } },
    ])
    expect(await updateBranch(exec, '/repo')).toEqual({ branch: 'main', updated: true })
  })

  it('reports a no-op when the upstream already contains HEAD', async () => {
    const exec = scripted([
      { args: ['fetch', '--all', '--prune'] },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'aaa111\n' } },
      { args: ['merge', '--ff-only', '@{u}'], out: { stdout: 'Already up to date.\n' } },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'aaa111\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'main\n' } },
    ])
    expect(await updateBranch(exec, '/repo')).toEqual({ branch: 'main', updated: false })
  })

  it('carries the mirror rewrite into the fetch phase only, never the merge', async () => {
    const exec = scripted([
      { args: ['-c', 'url.https://gh-proxy.com/.insteadOf=https://github.com/', 'fetch', '--all', '--prune'] },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'aaa111\n' } },
      { args: ['merge', '--ff-only', '@{u}'], out: { stdout: 'Already up to date.\n' } },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'aaa111\n' } },
      { args: ['branch', '--show-current'], out: { stdout: 'main\n' } },
    ])
    expect(await updateBranch(exec, '/repo', 'https://gh-proxy.com/')).toEqual({ branch: 'main', updated: false })
  })

  it('surfaces a fast-forward refusal on a diverged branch', async () => {
    const exec = scripted([
      { args: ['fetch', '--all', '--prune'] },
      { args: ['rev-parse', 'HEAD'], out: { stdout: 'aaa111\n' } },
      { args: ['merge', '--ff-only', '@{u}'],
        out: { code: 128, stderr: 'fatal: Not possible to fast-forward, aborting.\n' } },
    ])
    await expect(updateBranch(exec, '/repo')).rejects.toThrow('Not possible to fast-forward')
  })
})

describe('pushBranch', () => {
  it('lets git push report a missing upstream instead of failing in the probe', async () => {
    const exec = scripted([
      { args: ['rev-parse', '@{u}'], out: { code: 128, stderr: 'fatal: no upstream configured\n' } },
      { args: ['push'], out: { code: 128, stdout: 'fatal: current branch has no upstream branch\n' } },
    ])
    await expect(pushBranch(exec, '/repo')).rejects.toThrow('fatal: current branch has no upstream branch')
  })

  it('uses the process error when a failed command has no output', async () => {
    const exec = scripted([
      { args: ['rev-parse', '@{u}'], out: { stdout: 'abc\n' } },
      { args: ['push'], out: { code: 1, errorMessage: 'spawn git ENOENT' } },
    ])
    await expect(pushBranch(exec, '/repo')).rejects.toThrow('spawn git ENOENT')
  })

  it('gives the push the wide network budget, not the local default', async () => {
    // A slow-link push outruns the local 20s default, and a killed push may
    // have already updated the remote refs — the error toast would fire for
    // a push that actually landed.
    const seen: Array<number | undefined> = []
    const exec: Exec = async (_file, args, options) => {
      seen.push(options.timeoutMs)
      return { code: 0, stdout: 'abc\n', stderr: '' }
    }
    await pushBranch(exec, '/repo')
    const pushCall = seen[1]
    expect(pushCall).toBe(NETWORK_TIMEOUT_MS)
    // The @{u} probe stays on the local default.
    expect(seen[0]).toBeUndefined()
  })

  it('never injects the mirror rewrite: pushes stay direct, even accelerated', async () => {
    // Public accelerators have no receive-pack, and rewriting the push would
    // hand the pushed content to a third party. The injection point does not
    // exist on this path — assert the argv is bare.
    const argvs: string[][] = []
    const exec: Exec = async (_file, args) => {
      argvs.push([...args])
      return { code: 0, stdout: 'abc\n', stderr: '' }
    }
    await pushBranch(exec, '/repo')
    for (const args of argvs) {
      expect(args).not.toContain('-c')
    }
    expect(argvs[1]).toEqual(['push'])
  })
})

describe('listTagNames', () => {
  it('lists the local tag names, dropping the blank tail line', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/tags', '--format=%(refname:short)'], out: { stdout: 'v1.0.6\nv1/release\n' } },
    ])
    expect(await listTagNames(exec, '/repo')).toEqual(['v1.0.6', 'v1/release'])
  })

  it('answers an empty list for a repository with no tags', async () => {
    const exec = scripted([
      { args: ['for-each-ref', 'refs/tags', '--format=%(refname:short)'], out: { stdout: '' } },
    ])
    expect(await listTagNames(exec, '/repo')).toEqual([])
  })
})

describe('resolvePushRemote', () => {
  it('takes the checked-out branch upstream remote', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], out: { stdout: 'origin/main\n' } },
    ])
    expect(await resolvePushRemote(exec, '/repo')).toEqual({ ok: true, remote: 'origin' })
  })

  it('falls back to remote.pushDefault when the branch has no upstream', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        out: { code: 128, stderr: 'fatal: no upstream configured for branch' } },
      { args: ['config', '--get', 'remote.pushDefault'], out: { stdout: 'fork\n' } },
    ])
    expect(await resolvePushRemote(exec, '/repo')).toEqual({ ok: true, remote: 'fork' })
  })

  it('falls back to the only remote there is', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        out: { code: 128, stderr: 'fatal: HEAD does not point to a branch' } },
      { args: ['config', '--get', 'remote.pushDefault'], out: { code: 1 } },
      { args: ['remote'], out: { stdout: 'origin\n' } },
    ])
    expect(await resolvePushRemote(exec, '/repo')).toEqual({ ok: true, remote: 'origin' })
  })

  it('refuses to guess between several remotes', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        out: { code: 128, stderr: 'fatal: HEAD does not point to a branch' } },
      { args: ['config', '--get', 'remote.pushDefault'], out: { code: 1 } },
      { args: ['remote'], out: { stdout: 'origin\nupstream\n' } },
    ])
    const choice = await resolvePushRemote(exec, '/repo')
    expect(choice.ok).toBe(false)
    expect(choice.ok ? '' : choice.message).toContain('multiple remotes (origin, upstream)')
    expect(choice.ok ? '' : choice.message).toContain('remote.pushDefault')
  })

  it('reports a repository with no remote at all', async () => {
    const exec = scripted([
      { args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        out: { code: 128, stderr: 'fatal: HEAD does not point to a branch' } },
      { args: ['config', '--get', 'remote.pushDefault'], out: { code: 1 } },
      { args: ['remote'], out: { stdout: '\n' } },
    ])
    const choice = await resolvePushRemote(exec, '/repo')
    expect(choice.ok).toBe(false)
    expect(choice.ok ? '' : choice.message).toContain('no remote to push the tag to')
  })
})

describe('pushTag', () => {
  it('pushes the one refspec, explicitly named on both sides', async () => {
    const argvs: string[][] = []
    const exec: Exec = async (_file, args) => {
      argvs.push([...args])
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaa\n', stderr: '' }
      if (args[0] === 'ls-remote') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const outcome = await pushTag(exec, '/repo', 'v1.0.6', 'origin')
    expect(outcome).toEqual({ tag: 'v1.0.6', remote: 'origin', pushed: true })
    expect(argvs).toEqual([
      ['rev-parse', '--verify', 'refs/tags/v1.0.6'],
      ['ls-remote', '--refs', 'origin', 'refs/tags/v1.0.6'],
      ['push', 'origin', 'refs/tags/v1.0.6:refs/tags/v1.0.6'],
    ])
    // No force, no mirror rewrite: a menu click publishes one tag, never
    // overwrites a tag someone else already published.
    for (const args of argvs) {
      expect(args).not.toContain('--force')
      expect(args).not.toContain('-f')
      expect(args).not.toContain('-c')
    }
  })

  it('skips the push when the remote already carries the same tag object', async () => {
    // The scripted executor throws on an unexpected call, so a third call
    // (the push) fails the test on its own.
    const exec = scripted([
      { args: ['rev-parse', '--verify', 'refs/tags/v1.0.6'], out: { stdout: 'aaaa\n' } },
      { args: ['ls-remote', '--refs', 'origin', 'refs/tags/v1.0.6'],
        out: { stdout: 'aaaa\trefs/tags/v1.0.6\n' } },
    ])
    expect(await pushTag(exec, '/repo', 'v1.0.6', 'origin'))
      .toEqual({ tag: 'v1.0.6', remote: 'origin', pushed: false })
  })

  it('compares the ANNOTATED tag object, not the commit it peels to', async () => {
    // An annotated tag's own object id is what both sides report: a remote
    // carrying the same tag object is up to date even though `^{}` differs.
    const exec = scripted([
      { args: ['rev-parse', '--verify', 'refs/tags/v1.0.6'], out: { stdout: 'tagobj\n' } },
      { args: ['ls-remote', '--refs', 'origin', 'refs/tags/v1.0.6'],
        out: { stdout: 'tagobj\trefs/tags/v1.0.6\n' } },
    ])
    expect(await pushTag(exec, '/repo', 'v1.0.6', 'origin')).toMatchObject({ pushed: false })
  })

  it("surfaces git's refusal when the remote tag points somewhere else", async () => {
    const exec = scripted([
      { args: ['rev-parse', '--verify', 'refs/tags/v1.0.6'], out: { stdout: 'aaaa\n' } },
      { args: ['ls-remote', '--refs', 'origin', 'refs/tags/v1.0.6'],
        out: { stdout: 'bbbb\trefs/tags/v1.0.6\n' } },
      { args: ['push', 'origin', 'refs/tags/v1.0.6:refs/tags/v1.0.6'],
        out: { code: 1, stderr: 'error: failed to push some refs\nhint: the tag already exists in the remote' } },
    ])
    await expect(pushTag(exec, '/repo', 'v1.0.6', 'origin'))
      .rejects.toThrow('already exists in the remote')
  })

  it('gives both network calls the wide budget, not the local default', async () => {
    const seen: Array<number | undefined> = []
    const exec: Exec = async (_file, args, options) => {
      seen.push(options.timeoutMs)
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaa\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await pushTag(exec, '/repo', 'v1.0.6', 'origin')
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBe(NETWORK_TIMEOUT_MS)
    expect(seen[2]).toBe(NETWORK_TIMEOUT_MS)
  })
})

describe('probeWorkspaceGit', () => {
  /** Platform-real directory shapes — Windows runs get drive-qualified paths. */
  const REPO = resolve('/repo')
  const WT = resolve('/wt/feat-x')
  /** Git porcelain prints forward slashes even on Windows. */
  const slashes = (value: string): string => value.replace(/\\/g, '/')
  /** The one combined rev-parse the probe issues (toplevel / common dir / branch). */
  const COMBINED = ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'] as const

  it('marks a main checkout main and reports its branch', async () => {
    const exec = scripted([
      { args: COMBINED, out: { stdout: `${slashes(REPO)}\n.git\nmain\n` } },
    ])
    expect(await probeWorkspaceGit(exec, REPO)).toEqual({
      repoRoot: REPO, repoName: 'repo', branch: 'main', main: true,
    })
  })

  it('groups a linked worktree under the main repository its common dir names', async () => {
    const exec = scripted([
      // GIT_COMMON_DIR of a linked worktree is the path back to the SHARED
      // `<repo>/.git` — real git often prints it relative to the worktree.
      { args: COMBINED, out: { stdout: `${slashes(WT)}\n../../repo/.git\nfeat-x\n` } },
    ])
    // Same grouping key as the main checkout probe above: both resolve the
    // common dir to `<REPO>/.git`, both answer repoRoot REPO.
    expect(await probeWorkspaceGit(exec, WT)).toEqual({
      repoRoot: REPO, repoName: 'repo', branch: 'feat-x', main: false,
    })
  })

  it('normalizes a detached or unborn HEAD to a null branch', async () => {
    // `--abbrev-ref HEAD` answers git's synthetic HEAD for a detached or
    // unborn checkout — the same state `branch --show-current` reported as
    // empty, and the probe maps both to null.
    const exec = scripted([
      { args: COMBINED, out: { stdout: `${slashes(REPO)}\n.git\nHEAD\n` } },
    ])
    expect((await probeWorkspaceGit(exec, REPO))?.branch).toBeNull()
  })

  it('answers undefined outside any git repository', async () => {
    const exec = scripted([
      { args: COMBINED, out: { code: 128, stderr: 'fatal: not a git repository\n' } },
    ])
    expect(await probeWorkspaceGit(exec, '/plain')).toBeUndefined()
  })

  it('answers undefined when the combined rev-parse fails', async () => {
    const exec = scripted([
      { args: COMBINED, out: { code: 128, stderr: 'fatal: bad revision\n' } },
    ])
    expect(await probeWorkspaceGit(exec, REPO)).toBeUndefined()
  })

  it('answers undefined when git traversed up to an ancestor repository', async () => {
    const exec = scripted([
      { args: COMBINED, out: { stdout: `${slashes(REPO)}\n.git\nmain\n` } },
    ])
    expect(await probeWorkspaceGit(exec, resolve(REPO, 'subfolder'))).toBeUndefined()
  })
})

describe('inspectWorktree', () => {
  it('counts porcelain rows as dirty files and reads the ahead count', async () => {
    const exec = scripted([
      { args: ['status', '--porcelain'], out: { stdout: ' M a.ts\n?? b.ts\nM  c.ts\n' } },
      { args: ['rev-list', '--count', '@{u}..HEAD'], out: { stdout: '2\n' } },
    ])
    expect(await inspectWorktree(exec, '/wt')).toEqual({ dirty: 3, ahead: 2 })
  })

  it('reports no upstream as undefined ahead, not an error', async () => {
    const exec = scripted([
      { args: ['status', '--porcelain'], out: { stdout: '' } },
      { args: ['rev-list', '--count', '@{u}..HEAD'], out: { code: 128, stderr: "fatal: no upstream configured for branch 'dev'\n" } },
    ])
    expect(await inspectWorktree(exec, '/wt')).toEqual({ dirty: 0, ahead: undefined })
  })
})

describe('removeWorktree', () => {
  it('removes a live linked worktree, --force only when asked', async () => {
    const plain = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', p('/root/repo/feat-x')] },
    ])
    expect(await removeWorktree(plain, '/repo', '/root/repo/feat-x', false, () => true))
      .toEqual({ path: p('/root/repo/feat-x'), pruned: false })

    const forced = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', '--force', p('/root/repo/feat-x')] },
    ])
    expect(await removeWorktree(forced, '/repo', '/root/repo/feat-x', true, () => true))
      .toEqual({ path: p('/root/repo/feat-x'), pruned: false })
  })

  it('prunes a stale registration instead of spawning remove', async () => {
    const exec = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'prune'] },
    ])
    expect(await removeWorktree(exec, '/repo', '/root/repo/feat-x', false, () => false))
      .toEqual({ path: p('/root/repo/feat-x'), pruned: true })
  })

  it('refuses the main worktree and unregistered paths', async () => {
    const main = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    await expect(removeWorktree(main, '/repo', '/repo', false, () => true))
      .rejects.toThrow('cannot remove the main worktree')

    const unknown = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    await expect(removeWorktree(unknown, '/repo', '/elsewhere', false, () => true))
      .rejects.toThrow('is not a registered worktree')
  })

  it('surfaces a git refusal of the removal verbatim', async () => {
    const exec = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', p('/root/repo/feat-x')],
        out: { code: 128, stderr: 'fatal: unable to remove: file(s) locked\n' } },
    ])
    await expect(removeWorktree(exec, '/repo', '/root/repo/feat-x', false, () => true))
      .rejects.toThrow('locked')
  })

  it('treats Windows Permission denied as success after git already unregistered', async () => {
    const swept: string[] = []
    const exec = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', p('/root/repo/feat-x')],
        out: { code: 1, stderr: "error: failed to delete '/root/repo/feat-x': Permission denied\n" } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: MAIN_ONLY } },
    ])
    expect(await removeWorktree(exec, '/repo', '/root/repo/feat-x', false, () => true, async (path) => {
      swept.push(path)
      return 'gone'
    })).toEqual({ path: p('/root/repo/feat-x'), pruned: false })
    expect(swept).toEqual([p('/root/repo/feat-x')])
  })

  it('succeeds without a sweep when Permission denied left no leftover folder', async () => {
    let existsCalls = 0
    const exec = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', p('/root/repo/feat-x')],
        out: { code: 1, stderr: 'error: failed to delete: Permission denied\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: MAIN_ONLY } },
    ])
    expect(await removeWorktree(exec, '/repo', '/root/repo/feat-x', false, () => {
      existsCalls += 1
      return existsCalls === 1
    }, async () => {
      throw new Error('sweep must not run when the folder is already gone')
    })).toEqual({ path: p('/root/repo/feat-x'), pruned: false })
  })

  it('still refuses Permission denied when the worktree stays registered', async () => {
    const exec = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', p('/root/repo/feat-x')],
        out: { code: 1, stderr: 'error: failed to delete: Permission denied\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
    ])
    await expect(removeWorktree(exec, '/repo', '/root/repo/feat-x', false, () => true, async () => {
      throw new Error('sweep must not run while git still lists the worktree')
    })).rejects.toThrow('Permission denied')
  })

  it('still refuses Permission denied when the leftover directory has files', async () => {
    const exec = scripted([
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: TWO_WORKTREES } },
      { args: ['worktree', 'remove', p('/root/repo/feat-x')],
        out: { code: 1, stderr: 'error: failed to delete: Permission denied\n' } },
      { args: ['worktree', 'list', '--porcelain'], out: { stdout: MAIN_ONLY } },
    ])
    await expect(removeWorktree(exec, '/repo', '/root/repo/feat-x', false, () => true, async () => 'occupied'))
      .rejects.toThrow('Permission denied')
  })
})

describe('appendWorktreeExclude', () => {
  /** In-memory file map over the seams; a path absent from the map reads as
   * '' exactly like the real seam's ENOENT answer. */
  function memorySeams(files = new Map<string, string>()): { seams: ExcludeSeams; files: Map<string, string> } {
    return {
      files,
      seams: {
        readFile: async path => files.get(path) ?? '',
        appendFile: async (path, text) => { files.set(path, (files.get(path) ?? '') + text) },
        mkdir: async () => {},
      },
    }
  }

  const excludeOf = (repoRoot: string): string => join(repoRoot, '.git', 'info', 'exclude')

  it('appends the rule to a fresh repository (git init normally ships the file)', async () => {
    const { seams, files } = memorySeams()
    await expect(appendWorktreeExclude(seams, '/repo')).resolves.toBeUndefined()
    expect(files.get(excludeOf('/repo'))).toBe(`${WORKTREE_EXCLUDE_RULE}\n`)
  })

  it('appends behind a newline guard when the file lacks a trailing newline', async () => {
    const { seams, files } = memorySeams(new Map([[excludeOf('/repo'), '# my own rules']]))
    await expect(appendWorktreeExclude(seams, '/repo')).resolves.toBeUndefined()
    expect(files.get(excludeOf('/repo'))).toBe(`# my own rules\n${WORKTREE_EXCLUDE_RULE}\n`)
  })

  it('is idempotent: an existing rule leaves the file byte-identical', async () => {
    const content = `# git ls-files --others\n${WORKTREE_EXCLUDE_RULE}\n/other/\n`
    const { seams, files } = memorySeams(new Map([[excludeOf('/repo'), content]]))
    await expect(appendWorktreeExclude(seams, '/repo')).resolves.toBeUndefined()
    expect(files.get(excludeOf('/repo'))).toBe(content)
  })

  it('returns the failure text instead of throwing', async () => {
    const seams: ExcludeSeams = {
      readFile: async () => { throw new Error('EACCES: permission denied') },
      appendFile: async () => {},
      mkdir: async () => {},
    }
    await expect(appendWorktreeExclude(seams, '/repo')).resolves.toContain('EACCES')
  })
})
