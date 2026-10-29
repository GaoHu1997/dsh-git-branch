/**
 * Credential store tests: host normalization, masking, the `-c` auth header
 * generator, and the fs-backed store (atomic write + corrupt-file errors).
 *
 * The store is GLOBAL state living outside the repository, so its parsing
 * and writing rules get the same coverage as the routes that call them.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authConfigArgs,
  basicUsername,
  credentialFilePath,
  credentialHostIssue,
  credentialSecretIssue,
  credentialUsernameIssue,
  createCredentialStore,
  CredentialStoreError,
  maskSecret,
  normalizeCredentialHost,
  parseCredentialFile,
  removeCredential,
  serializeCredentialFile,
  sortCredentials,
  upsertCredential,
  type GitCredential,
} from '../src/credentials.ts'

const GITHUB: GitCredential = { host: 'github.com', username: 'octo', secret: 'ghp_secret', method: 'token', updatedAt: 1 }

/** One throwaway directory per test that needs real files. */
const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('normalizeCredentialHost', () => {
  it('keeps bare hosts and lowercases them', () => {
    expect(normalizeCredentialHost('GitHub.com')).toBe('github.com')
    expect(normalizeCredentialHost('  gitlab.com  ')).toBe('gitlab.com')
  })

  it('accepts a copied URL and reduces it to the host', () => {
    expect(normalizeCredentialHost('https://gitee.com/owner/repo.git')).toBe('gitee.com')
    expect(normalizeCredentialHost('https://user@github.com/owner/repo')).toBe('github.com')
    expect(normalizeCredentialHost('https://gitlab.example.com:8443/group/project')).toBe('gitlab.example.com:8443')
  })

  it('rejects blank and malformed values', () => {
    expect(normalizeCredentialHost('')).toBeUndefined()
    expect(normalizeCredentialHost('   ')).toBeUndefined()
    expect(normalizeCredentialHost('not a host')).toBeUndefined()
    expect(normalizeCredentialHost('-bad.example.com')).toBeUndefined()
    expect(normalizeCredentialHost('host..com')).toBeUndefined()
  })

  it('classifies issues for the routes', () => {
    expect(credentialHostIssue('')).toBe('empty')
    expect(credentialHostIssue('  ')).toBe('empty')
    expect(credentialHostIssue('bad host')).toBe('invalid')
    expect(credentialHostIssue('github.com')).toBeUndefined()
  })
})

describe('field validation', () => {
  it('rejects empty usernames and control characters', () => {
    expect(credentialUsernameIssue('')).toBe('empty')
    expect(credentialUsernameIssue('  ')).toBe('empty')
    expect(credentialUsernameIssue('bad\u0000name')).toBe('illegal')
    expect(credentialUsernameIssue('octo')).toBeUndefined()
  })

  it('lets a token credential omit the username', () => {
    expect(credentialUsernameIssue('', 'token')).toBeUndefined()
    expect(credentialUsernameIssue('   ', 'token')).toBeUndefined()
    expect(credentialUsernameIssue('', 'password')).toBe('empty')
    expect(credentialUsernameIssue('bad\u0000name', 'token')).toBe('illegal')
    expect(basicUsername({ ...GITHUB, username: '' })).toBe('oauth2')
    expect(basicUsername(GITHUB)).toBe('octo')
  })

  it('rejects empty secrets and control characters', () => {
    expect(credentialSecretIssue('')).toBe('empty')
    expect(credentialSecretIssue('a\nb')).toBe('illegal')
    expect(credentialSecretIssue('ghp_x')).toBeUndefined()
  })
})

describe('maskSecret', () => {
  it('keeps only the last four characters', () => {
    expect(maskSecret('ghp_1234567890')).toBe('****7890')
  })

  it('hides short secrets completely', () => {
    expect(maskSecret('abcd')).toBe('****')
    expect(maskSecret('a')).toBe('****')
  })
})

describe('authConfigArgs', () => {
  it('emits one basic extraHeader per host', () => {
    const args = authConfigArgs([GITHUB])
    const encoded = Buffer.from('octo:ghp_secret').toString('base64')
    expect(args).toEqual(['-c', `http.https://github.com/.extraHeader=AUTHORIZATION: basic ${encoded}`])
  })

  it('dedupes hosts, last entry winning', () => {
    const later: GitCredential = { ...GITHUB, secret: 'newer', updatedAt: 2 }
    const args = authConfigArgs([GITHUB, later])
    expect(args).toHaveLength(2)
    expect(Buffer.from(args[1]!.split(' ').pop()!, 'base64').toString()).toBe('octo:newer')
  })

  it('fills the placeholder user for a token stored without one', () => {
    const args = authConfigArgs([{ ...GITHUB, username: '' }])
    const encoded = Buffer.from('oauth2:ghp_secret').toString('base64')
    expect(args).toEqual(['-c', `http.https://github.com/.extraHeader=AUTHORIZATION: basic ${encoded}`])
  })

  it('returns nothing for an empty list', () => {
    expect(authConfigArgs([])).toEqual([])
  })
})

describe('upsertCredential / removeCredential / sortCredentials', () => {
  it('replaces the same host and appends a new one', () => {
    const next = upsertCredential([GITHUB], { ...GITHUB, username: 'renamed', updatedAt: 5 })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ username: 'renamed', updatedAt: 5 })
    const added = upsertCredential(next, { host: 'gitee.com', username: 'u', secret: 's', method: 'password', updatedAt: 6 })
    expect(added.map(entry => entry.host)).toEqual(['gitee.com', 'github.com'])
  })

  it('removes by host and leaves the rest untouched', () => {
    expect(removeCredential([GITHUB], 'github.com')).toEqual([])
    expect(removeCredential([GITHUB], 'gitlab.com')).toEqual([GITHUB])
  })

  it('sorts by host', () => {
    const sorted = sortCredentials([
      { ...GITHUB, host: 'gitee.com' },
      { ...GITHUB, host: 'github.com' },
      { ...GITHUB, host: 'gitlab.com' },
    ])
    expect(sorted.map(entry => entry.host)).toEqual(['gitee.com', 'github.com', 'gitlab.com'])
  })
})

describe('parseCredentialFile / serializeCredentialFile', () => {
  it('round-trips a store', () => {
    const text = serializeCredentialFile([GITHUB])
    expect(parseCredentialFile(text)).toEqual([GITHUB])
    expect(JSON.parse(text)).toMatchObject({ version: 1 })
  })

  it('tolerates unknown fields and a missing updatedAt', () => {
    const text = JSON.stringify({ version: 1, credentials: [{ host: 'github.com', username: 'u', secret: 's', method: 'password', extra: true }] })
    expect(parseCredentialFile(text)).toEqual([
      { host: 'github.com', username: 'u', secret: 's', method: 'password', updatedAt: 0 },
    ])
  })

  it('rejects a broken document with a store error naming the path', () => {
    expect(() => parseCredentialFile('{oops', 'creds.json')).toThrow(CredentialStoreError)
    expect(() => parseCredentialFile('{oops', 'creds.json')).toThrow(/creds\.json/)
    expect(() => parseCredentialFile(JSON.stringify({ credentials: [{ host: 'bad host' }] }))).toThrow(CredentialStoreError)
    expect(() => parseCredentialFile(JSON.stringify({ credentials: [{ host: 'a.com', username: 5, secret: 's', method: 'token' }] }))).toThrow(CredentialStoreError)
    expect(() => parseCredentialFile(JSON.stringify({ credentials: [{ host: 'a.com', username: 'u', secret: 5, method: 'token' }] }))).toThrow(CredentialStoreError)
    expect(() => parseCredentialFile(JSON.stringify({ credentials: [{ host: 'a.com', username: 'u', secret: 's', method: 'nope' }] }))).toThrow(CredentialStoreError)
  })
})

describe('credentialFilePath', () => {
  it('lives under DSH_HOME when set', () => {
    expect(credentialFilePath('/home/u', '/dsh')).toBe(join('/dsh', 'git-credentials.json'))
  })

  it('falls back to ~/.dsh and ignores a blank DSH_HOME', () => {
    expect(credentialFilePath('/home/u', undefined)).toBe(join('/home/u', '.dsh', 'git-credentials.json'))
    expect(credentialFilePath('/home/u', '  ')).toBe(join('/home/u', '.dsh', 'git-credentials.json'))
  })
})

describe('createCredentialStore', () => {
  it('loads an absent file as an empty list', async () => {
    const dir = await tempDir()
    const store = createCredentialStore(join(dir, 'git-credentials.json'))
    expect(await store.load()).toEqual([])
  })

  it('treats a blank file as an empty list', async () => {
    const dir = await tempDir()
    const path = join(dir, 'git-credentials.json')
    await writeFile(path, '   \n')
    expect(await createCredentialStore(path).load()).toEqual([])
  })

  it('saves atomically and reads the entries back', async () => {
    const dir = await tempDir()
    const path = join(dir, 'nested', 'git-credentials.json')
    const store = createCredentialStore(path)
    await store.save([GITHUB])
    expect(await store.load()).toEqual([GITHUB])
    expect(JSON.parse(await readFile(path, 'utf8')).credentials).toHaveLength(1)
  })

  it('reports a corrupt document with the file path', async () => {
    const dir = await tempDir()
    const path = join(dir, 'git-credentials.json')
    await writeFile(path, 'not json')
    await expect(createCredentialStore(path).load()).rejects.toThrow(CredentialStoreError)
  })
})
