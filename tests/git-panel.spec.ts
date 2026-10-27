/**
 * Git-panel layer tests: pure parsers (porcelain -z, log format,
 * name-status/numstat) and the thin git wrappers over the injected exec seam.
 */

import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from '../src/git.ts'
import {
  collectAiDiff, commitFiles, createTag, isStageablePath, logHistory, parseLogOutput, parseNameStatus, parseNumstatCounts, parseStatusPorcelainZ, stagePaths, workingChanges,
} from '../src/git.ts'

describe('parseStatusPorcelainZ', () => {
  it('parses staged, unstaged, and untracked rows', () => {
    const changes = parseStatusPorcelainZ('M  a.ts\0 M b.ts\0A  c.ts\0?? d.md\0')
    expect(changes).toEqual([
      { path: 'a.ts', staged: 'M' },
      { path: 'b.ts', unstaged: 'M' },
      { path: 'c.ts', staged: 'A' },
      { path: 'd.md', untracked: true },
    ])
  })

  it('splits the rename original path from the next NUL field', () => {
    const changes = parseStatusPorcelainZ('R  new.txt\0old.txt\0 M keep.txt\0')
    expect(changes).toEqual([
      { path: 'new.txt', oldPath: 'old.txt', staged: 'R' },
      { path: 'keep.txt', unstaged: 'M' },
    ])
  })

  it('handles CJK paths and a trailing NUL', () => {
    const changes = parseStatusPorcelainZ('?? 说明 文档.md\0')
    expect(changes).toEqual([{ path: '说明 文档.md', untracked: true }])
  })

  it('collapses the unmerged XY pairs to conflict rows', () => {
    const changes = parseStatusPorcelainZ('UU c.txt\0DD d.txt\0AU e.txt\0UA f.txt\0 M a.ts\0')
    expect(changes).toEqual([
      { path: 'c.txt', unstaged: 'U' },
      { path: 'd.txt', unstaged: 'U' },
      { path: 'e.txt', unstaged: 'U' },
      { path: 'f.txt', unstaged: 'U' },
      { path: 'a.ts', unstaged: 'M' },
    ])
  })

  it('returns an empty list for a clean tree', () => {
    expect(parseStatusPorcelainZ('')).toEqual([])
  })

  it('keeps both columns of a partly staged file', () => {
    const changes = parseStatusPorcelainZ('MM both.ts\0')
    expect(changes).toEqual([{ path: 'both.ts', staged: 'M', unstaged: 'M' }])
  })
})

describe('parseLogOutput', () => {
  const record = [
    'hash1', 'h1', '作者', 'a@x.com', '2026-10-16T09:44:00+08:00', 'hash0', '主题行', '正文第一行\n\n正文第二行', 'HEAD -> main, tag: v1.0.2',
  ].join('\x1f')

  it('splits records on \\x1e and fields on \\x1f', () => {
    const commits = parseLogOutput(`\n${record}\x1e\n${record.replace('主题行', 'merge: 另一个')}\x1e`)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({
      hash: 'hash1', short: 'h1', authorName: '作者', authorEmail: 'a@x.com',
      parents: ['hash0'], subject: '主题行', refs: ['HEAD -> main', 'tag: v1.0.2'],
    })
    expect(commits[0]?.date).toBe(Date.parse('2026-10-16T09:44:00+08:00'))
    expect(commits[0]?.body).toContain('正文第二行')
  })

  it('maps empty parents and refs to empty arrays', () => {
    const commits = parseLogOutput('\nhash1\th1\tA\t@x\t2026-01-01T00:00:00Z\t\tjust a subject\t\t\x1e'.replace(/\t/g, '\x1f'))
    expect(commits[0]?.parents).toEqual([])
    expect(commits[0]?.refs).toEqual([])
  })

  it('ignores a trailing empty record', () => {
    expect(parseLogOutput(`\n${record}\x1e`)).toHaveLength(1)
  })
})

describe('parseNameStatus + parseNumstatCounts', () => {
  it('parses rename rows with the old path', () => {
    const rows = parseNameStatus('M\ta.bin\nR050\told.txt\tnew.txt\nA\td.txt\n')
    expect(rows).toEqual([
      { path: 'a.bin', status: 'M' },
      { path: 'new.txt', oldPath: 'old.txt', status: 'R' },
      { path: 'd.txt', status: 'A' },
    ])
  })

  it('reads counts by index, mapping - to binary', () => {
    const counts = parseNumstatCounts('-\t-\ta.bin\n1\t0\told.txt => new.txt\n3\t1\td.txt\n')
    expect(counts).toEqual([
      { insertions: undefined, deletions: undefined },
      { insertions: 1, deletions: 0 },
      { insertions: 3, deletions: 1 },
    ])
  })
})

/** Scripted executor keyed by the joined argument prefix. */
function scripted(table: Record<string, Partial<ExecResult>>): Exec {
  return async (_file, args) => {
    const key = args.join(' ')
    const entry = Object.entries(table).find(([prefix]) => key === prefix || key.startsWith(prefix))
    if (entry === undefined) throw new Error(`unexpected git call: git ${key}`)
    return { code: 0, stdout: '', stderr: '', ...entry[1] }
  }
}

describe('workingChanges', () => {
  it('runs porcelain -z with core.quotepath=false', async () => {
    const exec = scripted({ '-c core.quotepath=false status --porcelain=v1 -z': { stdout: 'M  a.ts\0' } })
    const { changes } = await workingChanges(exec, '/repo')
    expect(changes).toEqual([{ path: 'a.ts', staged: 'M' }])
  })
})

describe('stagePaths', () => {
  it('stages with git add -- paths', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    await stagePaths(exec, '/repo', ['a.ts', 'b c.ts'], true)
    expect(calls[0]).toEqual(['add', '--', 'a.ts', 'b c.ts'])
  })

  it('unstages with git reset -q HEAD -- paths', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    await stagePaths(exec, '/repo', ['a.ts'], false)
    expect(calls[0]).toEqual(['reset', '-q', 'HEAD', '--', 'a.ts'])
  })
})

describe('isStageablePath', () => {
  it('accepts relative paths with spaces and CJK', () => {
    expect(isStageablePath('src/a b/说明.md')).toBe(true)
  })

  it('accepts the collapsed untracked-directory form (one trailing slash)', () => {
    expect(isStageablePath('src/client/panel/')).toBe(true)
    expect(isStageablePath('dir/')).toBe(true)
  })

  it('rejects absolute paths, .. escapes, and empty segments', () => {
    expect(isStageablePath('/etc/passwd')).toBe(false)
    expect(isStageablePath('C:\\Windows')).toBe(false)
    expect(isStageablePath('a/../../b')).toBe(false)
    expect(isStageablePath('a//b')).toBe(false)
    expect(isStageablePath('')).toBe(false)
  })
})

describe('logHistory', () => {
  it('verifies a named ref before logging', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc123\n', stderr: '' }
      return { code: 0, stdout: '\nh1\x1fh1\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1f\x1fs\x1f\x1f\x1e', stderr: '' }
    }
    const commits = await logHistory(exec, '/repo', 50, 0, 'main')
    expect(commits[0]?.subject).toBe('s')
    const logCall = calls.find(args => args[0] === 'log')
    expect(logCall).toContain('abc123')
  })

  it('answers an empty page for an unborn checkout (probe HEAD, not the stderr text)', async () => {
    const exec = scripted({
      'log --max-count=50 --skip=0 --topo-order --date=iso-strict': {
        code: 128,
        stderr: "fatal: your current branch 'master' does not have any commits yet",
      },
      // The refusal text is locale-dependent; the fallback verifies HEAD instead.
      'rev-parse --verify --quiet HEAD': { code: 128 },
    })
    expect(await logHistory(exec, '/repo', 50, 0)).toEqual([])
  })

  it('rethrows a log failure when HEAD exists (a real error, not unborn)', async () => {
    const exec = scripted({
      'log --max-count=50 --skip=0 --topo-order --date=iso-strict': { code: 128, stderr: 'fatal: bad object' },
      'rev-parse --verify --quiet HEAD': { stdout: 'abc123\n' },
    })
    await expect(logHistory(exec, '/repo', 50, 0)).rejects.toThrow(/bad object/)
  })

  it('logs HEAD directly without a verify round trip', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    await logHistory(exec, '/repo', 10, 5)
    const logCall = calls.find(args => args[0] === 'log')
    // --topo-order is unconditional: the graph layout reads parents, and a
    // date-ordered walk puts a branch's commit above the merge base it
    // forked from, drawing edges into rows that do not exist yet.
    expect(logCall).toEqual(['log', '--max-count=10', '--skip=5', '--topo-order', '--date=iso-strict', expect.stringContaining('%x1f')])
    expect(logCall).not.toContain('--all')
  })

  it('walks every ref when the filter asks for all', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    await logHistory(exec, '/repo', 50, 0, undefined, { all: true })
    expect(calls[0]).toContain('--all')
  })

  it('pushes the author and the resolved time bounds into the walk', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    const since = Date.UTC(2026, 9, 1)
    const until = Date.UTC(2026, 9, 27)
    await logHistory(exec, '/repo', 50, 0, undefined, { all: true, author: 'Ann', since, until })
    expect(calls[0]).toContain('--author=Ann')
    expect(calls[0]).toContain(`--since=${new Date(since).toISOString()}`)
    expect(calls[0]).toContain(`--until=${new Date(until).toISOString()}`)
  })

  it('lets a pinned ref win over --all', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'abc123\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await logHistory(exec, '/repo', 50, 0, 'main', { all: true })
    const logCall = calls.find(args => args[0] === 'log')
    // The verified object id - not the ref name - is what the walk starts at.
    expect(logCall).not.toContain('--all')
    expect(logCall).toContain('abc123')
  })
})

describe('createTag', () => {
  it('creates a lightweight tag when no message is given', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      if (args[0] === 'rev-list') return { code: 0, stdout: 'deadbeef\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await createTag(exec, '/repo', 'v1.0.0', 'abc123')
    expect(calls[0]).toEqual(['tag', 'v1.0.0', 'abc123'])
    expect(result).toEqual({ tag: 'v1.0.0', hash: 'deadbeef' })
  })

  it('creates an annotated tag when a message is given', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      if (args[0] === 'rev-list') return { code: 0, stdout: 'deadbeef\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await createTag(exec, '/repo', 'v2', 'abc123', 'release 2')
    expect(calls[0]).toEqual(['tag', '-a', 'v2', '-m', 'release 2', 'abc123'])
    expect(result.hash).toBe('deadbeef')
  })

  it('treats a blank message as no message at all', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      if (args[0] === 'rev-list') return { code: 0, stdout: 'deadbeef\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await createTag(exec, '/repo', 'v3', undefined, '   ')
    expect(calls[0]).toEqual(['tag', 'v3'])
  })

  it('surfaces a git refusal as a GitError', async () => {
    const exec: Exec = async () => ({ code: 128, stdout: '', stderr: 'fatal: tag already exists' })
    await expect(createTag(exec, '/repo', 'v1.0.0')).rejects.toThrow(/tag already exists/)
  })
})

describe('commitFiles', () => {
  it('verifies the hash and merges name-status with numstat counts', async () => {
    const exec = scripted({
      'rev-parse --verify --quiet abc123^{commit}': { stdout: 'abc123full\n' },
      '-c core.quotepath=false show --name-status -M --format=': { stdout: 'M\ta.ts\nR100\told.txt\tnew.txt\n' },
      '-c core.quotepath=false show --numstat -M --format=': { stdout: '2\t1\ta.ts\n5\t0\told.txt => new.txt\n' },
    })
    const files = await commitFiles(exec, '/repo', 'abc123')
    expect(files).toEqual([
      { path: 'a.ts', status: 'M', insertions: 2, deletions: 1 },
      { path: 'new.txt', oldPath: 'old.txt', status: 'R', insertions: 5, deletions: 0 },
    ])
  })

  it('marks binary files and omits their counts', async () => {
    const exec = scripted({
      'rev-parse --verify --quiet beef^{commit}': { stdout: 'beeffull\n' },
      '-c core.quotepath=false show --name-status -M --format=': { stdout: 'M\timg.png\n' },
      '-c core.quotepath=false show --numstat -M --format=': { stdout: '-\t-\timg.png\n' },
    })
    const files = await commitFiles(exec, '/repo', 'beef')
    expect(files).toEqual([{ path: 'img.png', status: 'M', binary: true }])
  })

  it('throws on an unknown hash', async () => {
    const exec = scripted({ 'rev-parse --verify --quiet dead^{commit}': { code: 1 } })
    await expect(commitFiles(exec, '/repo', 'dead')).rejects.toThrow(/unknown revision/)
  })
})

describe('collectAiDiff', () => {
  it('prefers the staged diff and reads recent subjects', async () => {
    const exec = scripted({
      '-c core.quotepath=false diff --cached': { stdout: 'diff --cached a.ts\n' },
      'log --max-count=10 --pretty=format:%s': { stdout: 'feat: one\nfix: two\n' },
    })
    const result = await collectAiDiff(exec, '/repo')
    expect(result.staged).toBe(true)
    expect(result.diff).toContain('diff --cached')
    expect(result.recentSubjects).toEqual(['feat: one', 'fix: two'])
  })

  it('falls back to the unstaged diff plus untracked names', async () => {
    const exec = scripted({
      '-c core.quotepath=false diff --cached': { stdout: '' },
      '-c core.quotepath=false diff': { stdout: 'diff a.ts\n' },
      '-c core.quotepath=false status --porcelain=v1 -z': { stdout: '?? notes.md\0' },
      'log --max-count=10 --pretty=format:%s': { stdout: '' },
    })
    const result = await collectAiDiff(exec, '/repo')
    expect(result.staged).toBe(false)
    expect(result.diff).toContain('Untracked file: notes.md')
  })

  it('truncates an oversized diff', async () => {
    const exec = scripted({
      '-c core.quotepath=false diff --cached': { stdout: 'x'.repeat(13_000) },
      'log --max-count=10 --pretty=format:%s': { stdout: '' },
    })
    const result = await collectAiDiff(exec, '/repo')
    expect(result.diff.length).toBeLessThanOrEqual(12_100)
    expect(result.diff).toContain('truncated')
  })
})
