import { describe, expect, it } from 'vitest'
import { CredentialStoreError, type CredentialStore, type GitCredential } from '../src/credentials.ts'
import { GIT_CREDENTIALS_TOOL_NAME, gitCredentialsTool, renderGitCredentials } from '../src/tool.ts'

const GITHUB: GitCredential = { host: 'github.com', username: 'octo', secret: 'ghp_secret', method: 'token', updatedAt: 1_700_000_000_000 }
const GITEE: GitCredential = { host: 'gitee.com', username: '', secret: 'gitee_tok', method: 'token', updatedAt: 0 }

function memoryStore(entries: readonly GitCredential[], path = '/home/u/.dsh/git-credentials.json'): CredentialStore {
  return {
    path,
    load: async () => [...entries],
    save: async () => undefined,
  }
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

function toolWith(store: CredentialStore) {
  return gitCredentialsTool({ home: () => '/home/u', envHome: () => undefined, store })
}

describe('gitCredentialsTool', () => {
  it('is named for the model and declares an output schema', () => {
    const tool = toolWith(memoryStore([]))
    expect(tool.name).toBe(GIT_CREDENTIALS_TOOL_NAME)
    expect(tool.description).toContain('Git credentials')
    expect(tool.parameters).toMatchObject({ type: 'object' })
    expect(tool.output.schema).toMatchObject({ type: 'object', required: ['path', 'total', 'credentials'] })
  })

  it('lists every host with masked secrets and the placeholder user', async () => {
    const value = await toolWith(memoryStore([GITEE, GITHUB])).execute({})
    expect(value.path).toBe('/home/u/.dsh/git-credentials.json')
    expect(value.total).toBe(2)
    expect(value.credentials).toEqual([
      { host: 'gitee.com', username: 'oauth2', method: 'token', secret: '****_tok', updatedAt: '' },
      { host: 'github.com', username: 'octo', method: 'token', secret: '****cret', updatedAt: '2023-11-14T22:13:20.000Z' },
    ])
  })

  it('filters by host, case-insensitively', async () => {
    const value = await toolWith(memoryStore([GITEE, GITHUB])).execute({ host: ' GitHub.com ' })
    expect(value.credentials.map(row => row.host)).toEqual(['github.com'])
    expect(value.total).toBe(2)
  })

  it('returns the raw secret only when explicitly asked', async () => {
    const masked = await toolWith(memoryStore([GITHUB])).execute({})
    expect(masked.credentials[0]?.secret).toBe('****cret')
    const raw = await toolWith(memoryStore([GITHUB])).execute({ includeSecret: true })
    expect(raw.credentials[0]?.secret).toBe('ghp_secret')
  })

  it('folds a read failure into the result instead of throwing', async () => {
    const value = await toolWith(brokenStore()).execute({})
    expect(value).toMatchObject({ total: 0, credentials: [] })
    expect(value.error).toContain('is not valid JSON')
    expect(renderGitCredentials(value)).toContain('git credentials are unavailable')
  })

  it('rejects arguments of the wrong type', async () => {
    const tool = toolWith(memoryStore([]))
    await expect(tool.execute({ host: 7 as unknown as string })).rejects.toThrow(/invalid host/)
    await expect(tool.execute({ includeSecret: 'yes' as unknown as boolean })).rejects.toThrow(/invalid includeSecret/)
  })

  it('renders one line per host', async () => {
    const value = await toolWith(memoryStore([GITEE, GITHUB])).execute({})
    const text = renderGitCredentials(value)
    expect(text).toContain('2 configured hosts')
    expect(text).toContain('- github.com · token · user octo · ****cret')
    expect(text).toContain('user oauth2')
  })
})
