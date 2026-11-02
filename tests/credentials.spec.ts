/**
 * Credential tests: host normalization, masking, the `~/.git-credentials`
 * line format (decision 0037), the fs-backed store that reads and rewrites
 * the machine's own credential file, the one-time migration from the retired
 * plugin-private JSON, and the generated `[include]` section in `~/.gitconfig`.
 *
 * These are GLOBAL state living outside the repository, so parsing, writing
 * and teardown rules get the same coverage as the routes that call them.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendGitconfigInclude,
  basicUsername,
  credentialFilePath,
  credentialHostIssue,
  credentialIncludeBody,
  credentialIncludeFile,
  credentialMetaFile,
  credentialSecretIssue,
  credentialUsernameIssue,
  createLocalCredentialStore,
  CredentialStoreError,
  encodeCredentialPart,
  ensureGitconfigInclude,
  formatCredentialLine,
  gitCredentialsFile,
  gitconfigHasInclude,
  maskSecret,
  migrateLegacyCredentialFile,
  normalizeCredentialHost,
  parseCredentialFile,
  parseGitCredentials,
  removeCredential,
  removeGitconfigInclude,
  sortCredentials,
  stripGitconfigInclude,
  upsertCredential,
  type GitCredential,
} from '../src/credentials.ts'

const GITHUB: GitCredential = { host: 'github.com', username: 'octo', secret: 'ghp_secret', method: 'password', updatedAt: 1 }

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

describe('credential paths', () => {
  it('stores secrets in the machine credential file and metadata under DSH home', () => {
    expect(gitCredentialsFile('/home/u')).toBe(join('/home/u', '.git-credentials'))
    expect(credentialMetaFile('/home/u', '/dsh')).toBe(join('/dsh', 'git-credentials.meta.json'))
    expect(credentialMetaFile('/home/u', undefined)).toBe(join('/home/u', '.dsh', 'git-credentials.meta.json'))
    expect(credentialIncludeFile('/home/u', '/dsh')).toBe(join('/dsh', 'git-credentials.include.gitconfig'))
  })

  it('keeps the retired JSON path for the one-time migration', () => {
    expect(credentialFilePath('/home/u', '/dsh')).toBe(join('/dsh', 'git-credentials.json'))
    expect(credentialFilePath('/home/u', undefined)).toBe(join('/home/u', '.dsh', 'git-credentials.json'))
    expect(credentialFilePath('/home/u', '  ')).toBe(join('/home/u', '.dsh', 'git-credentials.json'))
  })
})

describe('encodeCredentialPart / formatCredentialLine', () => {
  it('percent-encodes everything outside the unreserved set, in lowercase hex', () => {
    expect(encodeCredentialPart('plain-Token_1.2~3')).toBe('plain-Token_1.2~3')
    expect(encodeCredentialPart('u@x y')).toBe('u%40x%20y')
    expect(encodeCredentialPart('p@ss/word:1%')).toBe('p%40ss%2fword%3a1%25')
    expect(encodeCredentialPart('密码')).toBe('%e5%af%86%e7%a0%81')
  })

  it('writes the git store line shape', () => {
    expect(formatCredentialLine(GITHUB)).toBe('https://octo:ghp_secret@github.com')
  })

  it('fills the placeholder user for a token stored without one', () => {
    expect(formatCredentialLine({ ...GITHUB, username: '', method: 'token' })).toBe('https://oauth2:ghp_secret@github.com')
  })

  it('round-trips through parseGitCredentials, including reserved characters', () => {
    const tricky: GitCredential = { host: 'gitee.com', username: 'u@x y', secret: 'p@ss/word:1%', method: 'password', updatedAt: 0 }
    const text = `${formatCredentialLine(tricky)}\n`
    expect(parseGitCredentials(text).entries).toEqual([tricky])
  })
})

describe('parseGitCredentials', () => {
  it('keeps only https rows with a password', () => {
    const text = [
      '# managed by hand',
      'https://octo:ghp_secret@github.com',
      'ssh://git@github.com/owner/repo.git',
      'http://plain:insecure@github.com',
      'not a url',
      '',
    ].join('\n')
    const parsed = parseGitCredentials(text)
    expect(parsed.entries).toEqual([{ ...GITHUB, updatedAt: 0 }])
    expect(parsed.others).toEqual([
      '# managed by hand',
      'ssh://git@github.com/owner/repo.git',
      'http://plain:insecure@github.com',
      'not a url',
    ])
  })

  it('lets the last line for a host win', () => {
    const text = [
      'https://old:first@github.com',
      'https://new:second@github.com',
    ].join('\n')
    expect(parseGitCredentials(text).entries).toEqual([
      { host: 'github.com', username: 'new', secret: 'second', method: 'password', updatedAt: 0 },
    ])
  })

  it('maps the oauth2 placeholder back to an empty username', () => {
    expect(parseGitCredentials('https://oauth2:ghp_token@github.com').entries).toEqual([
      { host: 'github.com', username: '', secret: 'ghp_token', method: 'token', updatedAt: 0 },
    ])
  })

  it('tolerates a BOM and blank lines', () => {
    const parsed = parseGitCredentials('\uFEFF\nhttps://octo:ghp_secret@github.com\n\n')
    expect(parsed.entries).toEqual([{ ...GITHUB, updatedAt: 0 }])
    expect(parsed.others).toEqual([])
  })

  it('normalizes the stored port and lowercases the host', () => {
    expect(parseGitCredentials('https://u:p@GitLab.Example.com:8443').entries[0]?.host).toBe('gitlab.example.com:8443')
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

describe('parseCredentialFile (retired JSON, read only)', () => {
  it('reads entries and tolerates unknown fields', () => {
    const text = JSON.stringify({
      version: 1,
      credentials: [{ host: 'github.com', username: 'u', secret: 's', method: 'password', extra: true }],
    })
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

describe('createLocalCredentialStore', () => {
  it('loads an absent file as an empty list', async () => {
    const home = await tempDir()
    expect(await createLocalCredentialStore(home, undefined).load()).toEqual([])
  })

  it('points at the machine credential file', async () => {
    const home = await tempDir()
    expect(createLocalCredentialStore(home, undefined).path).toBe(join(home, '.git-credentials'))
  })

  it('saves the git store format plus a secret-free metadata sidecar', async () => {
    const home = await tempDir()
    const envHome = join(home, 'dsh')
    const store = createLocalCredentialStore(home, envHome)
    await store.save([GITHUB])

    expect(await readFile(join(home, '.git-credentials'), 'utf8')).toBe('https://octo:ghp_secret@github.com\n')
    if (process.platform !== 'win32') {
      expect((await stat(join(home, '.git-credentials'))).mode & 0o777).toBe(0o600)
    }

    const meta = await readFile(credentialMetaFile(home, envHome), 'utf8')
    expect(JSON.parse(meta)).toEqual({
      version: 1,
      credentials: [{ host: 'github.com', method: 'password', updatedAt: 1 }],
    })
    expect(meta).not.toContain('ghp_secret')

    expect(await store.load()).toEqual([GITHUB])
  })

  it('preserves lines the store does not own', async () => {
    const home = await tempDir()
    const path = join(home, '.git-credentials')
    await writeFile(path, '# hand-written\nssh://git@github.com/owner/repo.git\nhttps://octo:ghp_secret@github.com\n')
    const store = createLocalCredentialStore(home, undefined)

    expect((await store.load()).map(entry => entry.host)).toEqual(['github.com'])
    await store.save([{ ...GITHUB, host: 'gitee.com', username: 'u' }])

    const text = await readFile(path, 'utf8')
    expect(text.split('\n').filter(line => line !== '')).toEqual([
      '# hand-written',
      'ssh://git@github.com/owner/repo.git',
      'https://u:ghp_secret@gitee.com',
    ])
  })

  it('reports an unreadable file through the store error', async () => {
    const home = await tempDir()
    const store = createLocalCredentialStore(home, undefined)
    // A directory where the file is expected is not ENOENT, so it is a real error.
    await writeFile(join(home, 'placeholder'), '')
    await expect(
      (async () => {
        await rm(join(home, '.git-credentials'), { force: true })
        const { mkdir } = await import('node:fs/promises')
        await mkdir(join(home, '.git-credentials'))
        return store.load()
      })(),
    ).rejects.toThrow(CredentialStoreError)
  })

  it('infers token method from an oauth2 line without a metadata entry', async () => {
    const home = await tempDir()
    await writeFile(join(home, '.git-credentials'), 'https://oauth2:ghp_x@github.com\n')
    expect(await createLocalCredentialStore(home, undefined).load()).toEqual([
      { host: 'github.com', username: '', secret: 'ghp_x', method: 'token', updatedAt: 0 },
    ])
  })
})

describe('migrateLegacyCredentialFile', () => {
  it('imports the retired JSON into the local file and deletes it', async () => {
    const home = await tempDir()
    const envHome = join(home, 'dsh')
    const store = createLocalCredentialStore(home, envHome)

    const { mkdir } = await import('node:fs/promises')
    await mkdir(envHome, { recursive: true })
    const legacy = credentialFilePath(home, envHome)
    await writeFile(legacy, JSON.stringify({
      version: 1,
      credentials: [{ host: 'gitee.com', username: 'gitee-user', secret: 'gitee_tok', method: 'token', updatedAt: 9 }],
    }))

    expect(await migrateLegacyCredentialFile(home, envHome, store)).toBe(true)
    await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.load()).toEqual([
      { host: 'gitee.com', username: 'gitee-user', secret: 'gitee_tok', method: 'token', updatedAt: 9 },
    ])
  })

  it('keeps local entries for other hosts and lets the plugin value win on a shared host', async () => {
    const home = await tempDir()
    const envHome = join(home, 'dsh')
    const store = createLocalCredentialStore(home, envHome)
    await store.save([{ ...GITHUB, username: 'local-user', secret: 'local_secret' }])

    const { mkdir } = await import('node:fs/promises')
    await mkdir(envHome, { recursive: true })
    await writeFile(credentialFilePath(home, envHome), JSON.stringify({
      version: 1,
      credentials: [
        { host: 'github.com', username: 'plugin-user', secret: 'plugin_secret', method: 'password', updatedAt: 3 },
        { host: 'gitee.com', username: 'gitee-user', secret: 'gitee_tok', method: 'password', updatedAt: 4 },
      ],
    }))

    await migrateLegacyCredentialFile(home, envHome, store)
    const entries = await store.load()
    expect(entries.map(entry => [entry.host, entry.username])).toEqual([
      ['gitee.com', 'gitee-user'],
      ['github.com', 'plugin-user'],
    ])
  })

  it('is a no-op when the retired file is absent', async () => {
    const home = await tempDir()
    const store = createLocalCredentialStore(home, undefined)
    expect(await migrateLegacyCredentialFile(home, undefined, store)).toBe(false)
  })

  it('removes an empty retired file without touching the store', async () => {
    const home = await tempDir()
    const envHome = join(home, 'dsh')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(envHome, { recursive: true })
    const legacy = credentialFilePath(home, envHome)
    await writeFile(legacy, '  \n')
    const store = createLocalCredentialStore(home, envHome)

    expect(await migrateLegacyCredentialFile(home, envHome, store)).toBe(true)
    await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.load()).toEqual([])
  })
})

describe('credentialIncludeBody', () => {
  it('resets then installs the store helper per managed host', () => {
    expect(credentialIncludeBody(['github.com'])).toBe([
      '# Generated by dsh-git-branch (decision 0037). Do not edit:',
      '# every credential save rewrites this file.',
      '',
      '[credential "https://github.com/"]',
      '\thelper =',
      '\thelper = store',
      '',
    ].join('\n'))
  })

  it('sorts and dedupes hosts', () => {
    const body = credentialIncludeBody(['github.com', 'gitee.com', 'github.com'])
    expect(body.indexOf('gitee.com')).toBeLessThan(body.indexOf('github.com'))
    expect(body.match(/\[credential/g)).toHaveLength(2)
  })

  it('renders only the header when nothing is managed', () => {
    expect(credentialIncludeBody([])).toBe([
      '# Generated by dsh-git-branch (decision 0037). Do not edit:',
      '# every credential save rewrites this file.',
      '',
    ].join('\n'))
  })
})

describe('gitconfig include management', () => {
  const include = 'C:\\Users\\u\\.dsh\\git-credentials.include.gitconfig'

  it('detects the include with either slash direction and quotes', () => {
    expect(gitconfigHasInclude('[include]\n\tpath = C:/Users/u/.dsh/git-credentials.include.gitconfig\n', include)).toBe(true)
    expect(gitconfigHasInclude(`[include]\n\tpath = "${include}"\n`, include)).toBe(true)
    expect(gitconfigHasInclude('[include]\n\tpath = C:/other.gitconfig\n', include)).toBe(false)
    expect(gitconfigHasInclude('', include)).toBe(false)
  })

  it('appends the section without touching existing bytes, using forward slashes', () => {
    const text = appendGitconfigInclude('[user]\n\tname = u', include)
    expect(text).toBe('[user]\n\tname = u\n[include]\n\tpath = C:/Users/u/.dsh/git-credentials.include.gitconfig\n')
    expect(appendGitconfigInclude('', include)).toBe('[include]\n\tpath = C:/Users/u/.dsh/git-credentials.include.gitconfig\n')
  })

  it('creates the file once and is idempotent afterwards', async () => {
    const home = await tempDir()
    const gitconfig = join(home, '.gitconfig')
    const includePath = join(home, 'dsh', 'git-credentials.include.gitconfig')
    await writeFile(gitconfig, '[user]\n\tname = u\n')

    expect(await ensureGitconfigInclude(gitconfig, includePath)).toBe(true)
    const once = await readFile(gitconfig, 'utf8')
    expect(once).toContain('[user]\n\tname = u')
    expect(gitconfigHasInclude(once, includePath)).toBe(true)

    expect(await ensureGitconfigInclude(gitconfig, includePath)).toBe(false)
    expect(await readFile(gitconfig, 'utf8')).toBe(once)
  })

  it('creates a missing gitconfig', async () => {
    const home = await tempDir()
    const gitconfig = join(home, '.gitconfig')
    expect(await ensureGitconfigInclude(gitconfig, join(home, 'i.gitconfig'))).toBe(true)
    expect(await readFile(gitconfig, 'utf8')).toContain('[include]')
  })

  it('strips only the matching include section', () => {
    const text = [
      '[user]',
      '\tname = u',
      '[include]',
      '\tpath = C:/Users/u/.dsh/git-credentials.include.gitconfig',
      '[credential "https://github.com"]',
      '\thelper = manager',
      '',
    ].join('\n')
    const stripped = stripGitconfigInclude(text, include)
    expect(stripped).not.toContain('git-credentials.include.gitconfig')
    expect(stripped).toContain('[user]\n\tname = u')
    expect(stripped).toContain('[credential "https://github.com"]')
  })

  it('leaves an unrelated include section alone', () => {
    const text = '[include]\n\tpath = C:/other.gitconfig\n'
    expect(stripGitconfigInclude(text, include)).toBe(text)
  })

  it('removes the include on teardown and tolerates a missing file', async () => {
    const home = await tempDir()
    const gitconfig = join(home, '.gitconfig')
    const includePath = join(home, 'i.gitconfig')
    await writeFile(gitconfig, '[user]\n\tname = u\n')
    await ensureGitconfigInclude(gitconfig, includePath)

    await removeGitconfigInclude(gitconfig, includePath)
    expect(await readFile(gitconfig, 'utf8')).toBe('[user]\n\tname = u')
    await removeGitconfigInclude(join(home, 'absent.gitconfig'), includePath)
  })
})
