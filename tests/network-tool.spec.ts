import { describe, expect, it } from 'vitest'
import { CredentialStoreError, type CredentialStore, type GitCredential } from '../src/credentials.ts'
import type { Exec, ExecResult } from '../src/git.ts'
import {
  GIT_NETWORK_TOOL_NAME,
  gitNetworkRequestIssue,
  gitNetworkTool,
  redactSecrets,
  renderGitNetwork,
} from '../src/network-tool.ts'

const GITHUB: GitCredential = { host: 'github.com', username: 'octo', secret: 'ghp_secret', method: 'token', updatedAt: 1 }
const GITEE: GitCredential = { host: 'gitee.com', username: '', secret: 'gitee_tok', method: 'token', updatedAt: 0 }
const GITHUB_BASIC = Buffer.from('octo:ghp_secret', 'utf8').toString('base64')

function memoryStore(entries: readonly GitCredential[], path = '/home/u/.dsh/git-credentials.json'): CredentialStore {
  return { path, load: async () => [...entries], save: async () => undefined }
}

function brokenStore(): CredentialStore {
  return {
    path: '/home/u/.dsh/git-credentials.json',
    load: async () => {
      throw new CredentialStoreError('/home/u/.dsh/git-credentials.json', 'is not valid JSON')
    },
    save: async () => undefined,
  }
}

/** One recorded exec call plus the stub that records it. */
interface Call {
  file: string
  args: string[]
  cwd: string
  timeoutMs?: number
}

function recorder(result: Partial<ExecResult> = {}): { calls: Call[]; exec: Exec } {
  const calls: Call[] = []
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
    return { code: 0, stdout: '', stderr: '', ...result }
  }
  return { calls, exec }
}

function toolWith(store: CredentialStore, result: Partial<ExecResult> = {}) {
  const { calls, exec } = recorder(result)
  const tool = gitNetworkTool({ home: () => '/home/u', envHome: () => undefined, store, exec })
  return { tool, calls }
}

describe('gitNetworkRequestIssue', () => {
  it('accepts the four network subcommands', () => {
    for (const subcommand of ['fetch', 'pull', 'push', 'ls-remote']) {
      expect(gitNetworkRequestIssue('/repo', [subcommand])).toBeUndefined()
    }
    expect(gitNetworkRequestIssue('C:\\repo', ['push', 'origin', 'main'])).toBeUndefined()
  })

  it('rejects a relative or empty repoPath', () => {
    expect(gitNetworkRequestIssue('repo', ['push'])).toMatch(/absolute/)
    expect(gitNetworkRequestIssue('', ['push'])).toMatch(/non-empty/)
    expect(gitNetworkRequestIssue(7, ['push'])).toMatch(/non-empty/)
  })

  it('rejects an empty or non-string argument vector', () => {
    expect(gitNetworkRequestIssue('/repo', [])).toMatch(/non-empty array/)
    expect(gitNetworkRequestIssue('/repo', 'push')).toMatch(/non-empty array/)
    expect(gitNetworkRequestIssue('/repo', ['push', 7])).toMatch(/only strings/)
    expect(gitNetworkRequestIssue('/repo', [''])).toMatch(/empty or NUL/)
  })

  it('only allows the network subcommands', () => {
    expect(gitNetworkRequestIssue('/repo', ['status'])).toMatch(/not permitted here/)
    expect(gitNetworkRequestIssue('/repo', ['-c', 'http.x=y', 'push'])).toMatch(/not permitted here/)
    expect(gitNetworkRequestIssue('/repo', ['clone', 'https://github.com/o/r'])).toMatch(/not permitted here/)
  })

  it('rejects options that could replace the injected credential or spawn a program', () => {
    expect(gitNetworkRequestIssue('/repo', ['fetch', '-c', 'http.x=y'])).toMatch(/not permitted/)
    expect(gitNetworkRequestIssue('/repo', ['fetch', '--config-env=foo'])).toMatch(/not permitted/)
    expect(gitNetworkRequestIssue('/repo', ['fetch', '--upload-pack=evil'])).toMatch(/not permitted/)
    expect(gitNetworkRequestIssue('/repo', ['ls-remote', '--receive-pack', 'evil'])).toMatch(/not permitted/)
    expect(gitNetworkRequestIssue('/repo', ['pull', '--exec=tool'])).toMatch(/not permitted/)
  })

  it('rejects force and delete on push only', () => {
    for (const args of [['push', '--force'], ['push', '-f'], ['push', '--force-with-lease'], ['push', '--mirror'],
      ['push', '--delete', 'origin', 'main'], ['push', '-d', 'origin', 'main'], ['push', '--prune']]) {
      expect(gitNetworkRequestIssue('/repo', args)).toMatch(/never forces or deletes/)
    }
    expect(gitNetworkRequestIssue('/repo', ['push', '+main'])).toMatch(/refspec/)
    expect(gitNetworkRequestIssue('/repo', ['push', 'origin', ':main'])).toMatch(/refspec/)
    // fetch/ls-remote keep their legitimate force-ish/prune flags.
    expect(gitNetworkRequestIssue('/repo', ['fetch', '--prune', '--force'])).toBeUndefined()
    expect(gitNetworkRequestIssue('/repo', ['ls-remote', '-d', 'origin'])).toBeUndefined()
  })
})

describe('gitNetworkTool', () => {
  it('is named for the model and declares its parameter contract', () => {
    const { tool } = toolWith(memoryStore([]))
    expect(tool.name).toBe(GIT_NETWORK_TOOL_NAME)
    expect(tool.description).toContain('stored Git credentials')
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['repoPath', 'args'] })
    const required = (tool.output.schema as { required: string[] }).required
    expect(required).toEqual(expect.arrayContaining(['exitCode', 'authenticatedHosts']))
  })

  it('prepends one -c extraHeader per stored host and runs in repoPath', async () => {
    const { tool, calls } = toolWith(memoryStore([GITEE, GITHUB]), { stdout: 'ok\n' })
    const value = await tool.execute({ repoPath: '/repo', args: ['push', 'origin', 'main'] })
    const giteeBasic = Buffer.from('oauth2:gitee_tok', 'utf8').toString('base64')
    expect(calls[0]?.file).toBe('git')
    expect(calls[0]?.args).toEqual([
      '-c', `http.https://gitee.com/.extraHeader=AUTHORIZATION: basic ${giteeBasic}`,
      '-c', `http.https://github.com/.extraHeader=AUTHORIZATION: basic ${GITHUB_BASIC}`,
      'push', 'origin', 'main',
    ])
    expect(calls[0]?.cwd).toBe('/repo')
    expect(calls[0]?.timeoutMs).toBe(120_000)
    expect(value).toMatchObject({
      repoPath: '/repo',
      subcommand: 'push',
      exitCode: 0,
      stdout: 'ok\n',
      authenticatedHosts: ['gitee.com', 'github.com'],
      truncated: false,
    })
    expect(value).not.toHaveProperty('credentialsError')
  })

  it('does not throw on a non-zero exit and reports git diagnostics', async () => {
    const { tool } = toolWith(memoryStore([GITHUB]), { code: 128, stderr: "fatal: Authentication failed for 'https://github.com/o/r'\n" })
    const value = await tool.execute({ repoPath: '/repo', args: ['push'] })
    expect(value.exitCode).toBe(128)
    expect(value.stderr).toContain('Authentication failed')
  })

  it('falls back to the node error text when git produced no stderr', async () => {
    const { tool } = toolWith(memoryStore([]), { code: 1, errorMessage: 'spawn git ENOENT' })
    const value = await tool.execute({ repoPath: '/repo', args: ['fetch'] })
    expect(value.stderr).toContain('spawn git ENOENT')
  })

  it('redacts raw secrets and their Basic header form from both streams', async () => {
    const { tool } = toolWith(memoryStore([GITHUB]), {
      stdout: `remote=https://x:${GITHUB.secret}@github.com/o/r`,
      stderr: `basic ${GITHUB_BASIC}`,
    })
    const value = await tool.execute({ repoPath: '/repo', args: ['fetch'] })
    expect(value.stdout).not.toContain(GITHUB.secret)
    expect(value.stdout).toContain('****')
    expect(value.stderr).not.toContain(GITHUB_BASIC)
    expect(value.stderr).toContain('****')
  })

  it('runs bare and reports why when the credential file is unreadable', async () => {
    const { tool, calls } = toolWith(brokenStore(), { stdout: 'ok' })
    const value = await tool.execute({ repoPath: '/repo', args: ['fetch'] })
    expect(calls[0]?.args).toEqual(['fetch'])
    expect(value.authenticatedHosts).toEqual([])
    expect(value.credentialsError).toContain('is not valid JSON')
  })

  it('caps oversized output and flags truncation', async () => {
    const { tool } = toolWith(memoryStore([]), { stdout: 'x'.repeat(70_000) })
    const value = await tool.execute({ repoPath: '/repo', args: ['ls-remote'] })
    expect(value.stdout.length).toBe(65_536)
    expect(value.truncated).toBe(true)
  })

  it('throws the validation reason for an unusable request', async () => {
    const { tool } = toolWith(memoryStore([]))
    await expect(tool.execute({ repoPath: 'repo', args: ['push'] })).rejects.toThrow(/absolute/)
    await expect(tool.execute({ repoPath: '/repo', args: ['push', '--force'] })).rejects.toThrow(/never forces or deletes/)
    await expect(tool.execute({ repoPath: '/repo' })).rejects.toThrow(/non-empty array/)
  })

  it('renders the exit status, hosts and streams', async () => {
    const { tool } = toolWith(memoryStore([GITHUB]), { code: 0, stdout: 'main -> main' })
    const value = await tool.execute({ repoPath: '/repo', args: ['push'] })
    const text = renderGitNetwork(value)
    expect(text).toContain('git push (exit 0) in /repo')
    expect(text).toContain('credentials injected for: github.com')
    expect(text).toContain('--- stdout ---')
    expect(text).toContain('main -> main')
  })
})

describe('redactSecrets', () => {
  it('leaves text alone without credentials and collapses empty secrets', () => {
    expect(redactSecrets('hello', [])).toBe('hello')
    expect(redactSecrets('hello', [{ ...GITHUB, secret: '' }])).toBe('hello')
  })
})
