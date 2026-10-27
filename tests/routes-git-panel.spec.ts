/**
 * Git-panel route tests: body validation, staged executor runs, and the
 * failure envelopes of the seven panel handlers.
 */

import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from '../src/git.ts'
import {
  handleAiCommitMessage, handleChanges, handleCommit, handleCommitFiles, handleCreateTag, handleLog, handleStage,
  type LlmStreamRuntime, type RouteDeps,
} from '../src/routes.ts'

/** Minimal deps: only the exec seam matters for the panel handlers. */
function depsWith(exec: Exec): RouteDeps {
  return {
    exec,
    sectionRootDir: () => undefined,
    sectionFetchBeforeCreate: () => false,
    home: () => '/home/u',
    envHome: () => undefined,
    dirExists: () => true,
  }
}

/** Scripted executor keyed by the joined argument prefix. */
function scripted(table: Record<string, Partial<ExecResult>>): Exec {
  return async (_file, args) => {
    const key = args.join(' ')
    const entry = Object.entries(table).find(([prefix]) => key === prefix || key.startsWith(prefix))
    if (entry === undefined) throw new Error(`unexpected git call: git ${key}`)
    return { code: 0, stdout: '', stderr: '', ...entry[1] }
  }
}

/** Repo facts as `probeRepo` reads them for the fictional /repo checkout. */
const REPO_CALLS = {
  'rev-parse --show-toplevel': { stdout: '/repo\n' },
  'rev-parse --git-common-dir': { stdout: '/repo/.git\n' },
  'branch --show-current': { stdout: 'main\n' },
  'for-each-ref refs/heads': { stdout: 'main\n' },
  'for-each-ref refs/remotes': { stdout: '' },
  'worktree list --porcelain': { stdout: 'worktree /repo\nHEAD 1\nbranch refs/heads/main\n' },
} satisfies Record<string, Partial<ExecResult>>

describe('handleChanges', () => {
  it('returns parsed rows', async () => {
    const exec = scripted({ '-c core.quotepath=false status --porcelain=v1 -z': { stdout: 'M  a.ts\0?? b.md\0' } })
    const result = await handleChanges(depsWith(exec), { repoPath: '/repo' })
    expect(result).toMatchObject({ status: 200, body: { changes: [{ path: 'a.ts', staged: 'M' }, { path: 'b.md', untracked: true }] } })
  })

  it('rejects a relative repoPath and unknown keys', async () => {
    const exec = scripted({})
    expect((await handleChanges(depsWith(exec), { repoPath: 'rel' })).status).toBe(400)
    expect((await handleChanges(depsWith(exec), { repoPath: '/repo', extra: 1 })).status).toBe(400)
    expect((await handleChanges(depsWith(exec), 'nope')).status).toBe(400)
  })

  it('maps git failure to 400 with the stderr text', async () => {
    const exec = scripted({ '-c core.quotepath=false status --porcelain=v1 -z': { code: 128, stderr: 'fatal: not a git repository' } })
    const result = await handleChanges(depsWith(exec), { repoPath: '/repo' })
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringContaining('not a git repository') } })
  })

  it('caps the change list at 500 rows and flags the truncation', async () => {
    const stream = Array.from({ length: 501 }, (_, i) => `M  f${String(i).padStart(3, '0')}.ts\0`).join('')
    const exec = scripted({ '-c core.quotepath=false status --porcelain=v1 -z': { stdout: stream } })
    const result = await handleChanges(depsWith(exec), { repoPath: '/repo' })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ truncated: true, changes: expect.any(Array) })
    const body = result.body as { changes: unknown[] }
    expect(body.changes).toHaveLength(500)
  })
})

describe('handleStage', () => {
  it('runs git add for stage=true and reset for stage=false', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    expect(await handleStage(depsWith(exec), { repoPath: '/repo', paths: ['a.ts'], stage: true })).toMatchObject({ status: 200, body: { staged: true } })
    expect(await handleStage(depsWith(exec), { repoPath: '/repo', paths: ['a.ts'], stage: false })).toMatchObject({ status: 200, body: { staged: true } })
    expect(calls[0]).toEqual(['add', '--', 'a.ts'])
    expect(calls[1]).toEqual(['reset', '-q', 'HEAD', '--', 'a.ts'])
  })

  it('rejects absolute paths, .. escapes, and oversize batches', async () => {
    const exec = scripted({})
    expect((await handleStage(depsWith(exec), { repoPath: '/repo', paths: ['/abs'], stage: true })).status).toBe(400)
    expect((await handleStage(depsWith(exec), { repoPath: '/repo', paths: ['../out'], stage: true })).status).toBe(400)
    expect((await handleStage(depsWith(exec), { repoPath: '/repo', paths: Array.from({ length: 501 }, (_, i) => `f${String(i)}`), stage: true })).status).toBe(400)
    expect((await handleStage(depsWith(exec), { repoPath: '/repo', paths: [], stage: true })).status).toBe(400)
  })
})

describe('handleCommit', () => {
  it('commits and reports the hash plus subject', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return args[0] === 'rev-parse' ? { code: 0, stdout: 'abc123\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    }
    const result = await handleCommit(depsWith(exec), { repoPath: '/repo', message: 'feat: 新功能\n\n正文' })
    expect(result).toEqual({ status: 200, body: { hash: 'abc123', subject: 'feat: 新功能' } })
    expect(calls[0]).toEqual(['commit', '-m', 'feat: 新功能\n\n正文'])
  })

  it('rejects blank and oversize messages', async () => {
    const exec = scripted({})
    expect((await handleCommit(depsWith(exec), { repoPath: '/repo', message: '   ' })).status).toBe(400)
    expect((await handleCommit(depsWith(exec), { repoPath: '/repo', message: 'x'.repeat(2001) })).status).toBe(400)
  })

  it('surfaces git refusal (empty index) as 400', async () => {
    const exec = scripted({ 'commit -m': { code: 1, stderr: 'nothing to commit, working tree clean' } })
    const result = await handleCommit(depsWith(exec), { repoPath: '/repo', message: 'msg' })
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringContaining('nothing to commit') } })
  })
})

describe('handleLog', () => {
  it('returns one page and forwards limit/skip', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '\nh1\x1fh1\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1f\x1fs\x1f\x1f\x1e', stderr: '' }
    }
    const result = await handleLog(depsWith(exec), { repoPath: '/repo', limit: 10, skip: 5 })
    expect(result.status).toBe(200)
    const body = result.body as { commits: Array<{ subject: string }> }
    expect(body.commits[0]?.subject).toBe('s')
    const logCall = calls.find(args => args[0] === 'log')
    expect(logCall).toContain('--max-count=10')
    expect(logCall).toContain('--skip=5')
  })

  it('rejects out-of-range limit/skip and bad ref shapes', async () => {
    const exec = scripted({})
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', limit: 0 })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', limit: 201 })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', skip: -1 })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', ref: '-evil' })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', ref: '' })).status).toBe(400)
  })

  it('rejects a non-number limit', async () => {
    const exec = scripted({})
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', limit: 'ten' })).status).toBe(400)
  })

  it('forwards all/author/since/until into the walk', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    const since = Date.UTC(2026, 9, 1)
    const result = await handleLog(depsWith(exec), {
      repoPath: '/repo', all: true, author: 'Ann', since, until: Date.UTC(2026, 9, 27),
    })
    expect(result.status).toBe(200)
    const logCall = calls.find(args => args[0] === 'log')
    expect(logCall).toContain('--all')
    expect(logCall).toContain('--author=Ann')
    expect(logCall).toContain(`--since=${new Date(since).toISOString()}`)
  })

  it('rejects a blank or oversized author', async () => {
    const exec = scripted({})
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', author: '  ' })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', author: 'a'.repeat(201) })).status).toBe(400)
  })

  it('rejects a non-timestamp window and an inverted one', async () => {
    const exec = scripted({})
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', since: 0 })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', since: 'now' })).status).toBe(400)
    expect((await handleLog(depsWith(exec), { repoPath: '/repo', since: 2, until: 1 })).status).toBe(400)
  })
})

describe('handleCreateTag', () => {
  it('tags the given commit and returns the resolved hash', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_file, args) => {
      calls.push([...args])
      const entry = Object.entries(REPO_CALLS).find(([prefix]) => args.join(' ').startsWith(prefix))
      if (entry !== undefined) return { code: 0, stdout: '', stderr: '', ...entry[1] }
      if (args[0] === 'rev-list') return { code: 0, stdout: 'deadbeef\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: 'v1.0.0', target: 'abc123' })
    expect(result).toMatchObject({ status: 200, body: { tag: 'v1.0.0', hash: 'deadbeef' } })
    expect(calls.find(args => args[0] === 'tag')).toEqual(['tag', 'v1.0.0', 'abc123'])
  })

  it('rejects a flag-shaped name, a non-object-id target, and an oversize message', async () => {
    const exec = scripted({})
    expect((await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: '  ' })).status).toBe(400)
    expect((await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: '-evil' })).status).toBe(400)
    expect((await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: 'v1', target: 'main' })).status).toBe(400)
    expect((await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: 'v1', message: 'x'.repeat(5001) })).status).toBe(400)
    expect((await handleCreateTag(depsWith(exec), { repoPath: 'rel', name: 'v1' })).status).toBe(400)
    expect((await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: 'v1', extra: 1 })).status).toBe(400)
  })

  it('maps a duplicate tag refusal to 400 with git stderr', async () => {
    const exec = scripted({
      ...REPO_CALLS,
      tag: { code: 128, stderr: 'fatal: tag already exists' },
    })
    const result = await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: 'v1.0.0', target: 'abc123' })
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringContaining('tag already exists') } })
  })

  it('reports a non-repository path as 400', async () => {
    const exec = scripted({ 'rev-parse --show-toplevel': { code: 128, stderr: 'fatal: not a git repository' } })
    const result = await handleCreateTag(depsWith(exec), { repoPath: '/repo', name: 'v1' })
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringContaining('is not inside a git repository') } })
  })
})

describe('handleCommitFiles', () => {
  it('validates the hash shape and returns merged rows', async () => {
    const exec = scripted({
      'rev-parse --verify --quiet abc1234^{commit}': { stdout: 'abc1234full\n' },
      '-c core.quotepath=false show --name-status -M --format=': { stdout: 'M\ta.ts\n' },
      '-c core.quotepath=false show --numstat -M --format=': { stdout: '1\t0\ta.ts\n' },
    })
    const result = await handleCommitFiles(depsWith(exec), { repoPath: '/repo', hash: 'abc1234' })
    expect(result).toMatchObject({ status: 200, body: { hash: 'abc1234', files: [{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0 }] } })
    expect((await handleCommitFiles(depsWith(exec), { repoPath: '/repo', hash: 'not a hash!' })).status).toBe(400)
  })
})

describe('handleAiCommitMessage', () => {
  const llm: LlmStreamRuntime = {
    async *stream(options) {
      expect(options.provider).toBe('deepseek')
      expect(options.model).toBe('glm-5.3-flash')
      // The message content must be model-facing BLOCKS, not a bare string.
      expect(options.messages[0]?.content[0]).toEqual({ type: 'text', text: expect.stringContaining('Generate a git commit message') })
      yield { type: 'text-delta', text: 'feat: 生成' }
      yield { type: 'reasoning-delta', text: 'internal thoughts must not fold' }
      yield { type: 'text-delta', text: ' 的提交信息' }
    },
  }

  it('folds streamed chunks into one message', async () => {
    const exec = scripted({
      '-c core.quotepath=false diff --cached': { stdout: 'diff content\n' },
      'log --max-count=10 --pretty=format:%s': { stdout: 'feat: 历史\n' },
    })
    const result = await handleAiCommitMessage(
      depsWith(exec), llm,
      { repoPath: '/repo', provider: 'deepseek', model: 'glm-5.3-flash' },
    )
    expect(result).toEqual({ status: 200, body: { message: 'feat: 生成 的提交信息' } })
  })

  it('rejects empty provider/model and passes effort through', async () => {
    const exec = scripted({
      '-c core.quotepath=false diff --cached': { stdout: 'diff\n' },
      'log --max-count=10 --pretty=format:%s': { stdout: '' },
    })
    expect((await handleAiCommitMessage(depsWith(exec), llm, { repoPath: '/repo', provider: '', model: 'm' })).status).toBe(400)
    let seen: string | undefined
    const probingLlm: LlmStreamRuntime = {
      async *stream(options) {
        seen = options.reasoningEffort
        yield { type: 'text-delta', text: 'ok' }
      },
    }
    expect((await handleAiCommitMessage(depsWith(exec), probingLlm, { repoPath: '/repo', provider: 'p', model: 'm', effort: 'high' })).status).toBe(200)
    expect(seen).toBe('high')
  })

  it('answers 400 on a clean tree and 502 on an empty reply', async () => {
    const clean = scripted({
      '-c core.quotepath=false diff --cached': { stdout: '' },
      '-c core.quotepath=false diff': { stdout: '' },
      '-c core.quotepath=false status --porcelain=v1 -z': { stdout: '' },
      'log --max-count=10 --pretty=format:%s': { stdout: '' },
    })
    expect((await handleAiCommitMessage(depsWith(clean), llm, { repoPath: '/repo', provider: 'p', model: 'm' })).status).toBe(400)
    const emptyLlm: LlmStreamRuntime = { async *stream() { yield { type: 'text-delta', text: '' } } }
    const dirty = scripted({
      '-c core.quotepath=false diff --cached': { stdout: 'diff\n' },
      'log --max-count=10 --pretty=format:%s': { stdout: '' },
    })
    expect((await handleAiCommitMessage(depsWith(dirty), emptyLlm, { repoPath: '/repo', provider: 'p', model: 'm' })).status).toBe(502)
  })

  it('strips markdown fences from the reply', async () => {
    const fenced: LlmStreamRuntime = {
      async *stream() {
        yield { type: 'text-delta', text: '```txt\nfeat: fenced\n```' }
      },
    }
    const exec = scripted({
      '-c core.quotepath=false diff --cached': { stdout: 'diff\n' },
      'log --max-count=10 --pretty=format:%s': { stdout: '' },
    })
    const result = await handleAiCommitMessage(depsWith(exec), fenced, { repoPath: '/repo', provider: 'p', model: 'm' })
    expect(result).toEqual({ status: 200, body: { message: 'feat: fenced' } })
  })
})
