import { describe, expect, it } from 'vitest'
import { ACCEL_DEFAULT_URL, accelerateUrlError, branchNameIssue, isAbsoluteConfigPath, localBranchName, normalizeAccelerateUrl, remoteNameIssue, remoteUrlIssue, sanitizeBranchDir, splitRemoteBranch } from '../src/normalize.ts'

describe('sanitizeBranchDir', () => {
  it('keeps plain names unchanged', () => {
    expect(sanitizeBranchDir('main')).toBe('main')
  })

  it('turns slashes into dashes', () => {
    expect(sanitizeBranchDir('feat/auth-login')).toBe('feat-auth-login')
    expect(sanitizeBranchDir('origin/feat/x')).toBe('origin-feat-x')
  })

  it('replaces Windows-forbidden characters', () => {
    expect(sanitizeBranchDir('a<b>c:d"e|f?g*h')).toBe('a-b-c-d-e-f-g-h')
  })

  it('merges dash runs and strips trailing dots and spaces', () => {
    expect(sanitizeBranchDir('a//--..b.. ')).toBe('a-b')
  })

  it('clamps to 64 characters without a forbidden suffix', () => {
    expect(sanitizeBranchDir('x'.repeat(80))).toHaveLength(64)
    expect(sanitizeBranchDir(`${'x'.repeat(63)}.`)).toBe('x'.repeat(63))
  })

  it('never returns an empty segment', () => {
    expect(sanitizeBranchDir('???')).toBe('branch')
    expect(sanitizeBranchDir('///')).toBe('branch')
  })
})

describe('localBranchName', () => {
  it('strips the leading remote segment', () => {
    expect(localBranchName('origin/feat/x')).toBe('feat/x')
    expect(localBranchName('upstream/main')).toBe('main')
  })

  it('passes local names through', () => {
    expect(localBranchName('main')).toBe('main')
    expect(localBranchName('feat/x')).toBe('x')
  })
})

describe('splitRemoteBranch', () => {
  it('splits a remote display name', () => {
    expect(splitRemoteBranch('origin/feat/x')).toEqual({ remote: 'origin', name: 'feat/x' })
  })

  it('returns undefined for bare words and leading-slash names', () => {
    expect(splitRemoteBranch('main')).toBeUndefined()
    expect(splitRemoteBranch('/weird')).toBeUndefined()
  })
})

describe('isAbsoluteConfigPath', () => {
  it('accepts POSIX, drive, and UNC forms', () => {
    expect(isAbsoluteConfigPath('/home/u/wt')).toBe(true)
    expect(isAbsoluteConfigPath('C:\\wt')).toBe(true)
    expect(isAbsoluteConfigPath('D:/wt')).toBe(true)
    expect(isAbsoluteConfigPath('\\\\server\\wt')).toBe(true)
  })

  it('rejects relative and empty values', () => {
    expect(isAbsoluteConfigPath('')).toBe(false)
    expect(isAbsoluteConfigPath('wt/x')).toBe(false)
    expect(isAbsoluteConfigPath('~/.dsh/wt')).toBe(false)
  })
})

describe('branchNameIssue', () => {
  it('accepts ordinary and nested names', () => {
    expect(branchNameIssue('main')).toBeNull()
    expect(branchNameIssue('feat/auth-login')).toBeNull()
    expect(branchNameIssue('v1.2.3')).toBeNull()
    expect(branchNameIssue('user@host')).toBeNull()
  })

  it('rejects empty and whitespace-only drafts', () => {
    expect(branchNameIssue('')).toBe('empty')
    expect(branchNameIssue('   ')).toBe('empty')
  })

  it('rejects a leading dash before git can parse it as a flag', () => {
    expect(branchNameIssue('-feat')).toBe('leadingDash')
  })

  it('rejects git-forbidden characters and constructs', () => {
    expect(branchNameIssue('a b')).toBe('illegal')
    expect(branchNameIssue('a..b')).toBe('illegal')
    expect(branchNameIssue('a~b')).toBe('illegal')
    expect(branchNameIssue('a^b')).toBe('illegal')
    expect(branchNameIssue('a:b')).toBe('illegal')
    expect(branchNameIssue('a?b')).toBe('illegal')
    expect(branchNameIssue('a*b')).toBe('illegal')
    expect(branchNameIssue('a[b')).toBe('illegal')
    expect(branchNameIssue('a\\b')).toBe('illegal')
    expect(branchNameIssue('a@{b')).toBe('illegal')
    expect(branchNameIssue('a//b')).toBe('illegal')
    expect(branchNameIssue('/lead')).toBe('illegal')
    expect(branchNameIssue('trail/')).toBe('illegal')
    expect(branchNameIssue('trailing.')).toBe('illegal')
    expect(branchNameIssue('.dotted')).toBe('illegal')
    expect(branchNameIssue('feat/.hidden')).toBe('illegal')
    expect(branchNameIssue('feat/x.lock')).toBe('illegal')
    expect(branchNameIssue('@')).toBe('illegal')
  })
})

describe('accelerateUrlError', () => {
  it('accepts trimmed http(s) URLs without whitespace', () => {
    expect(accelerateUrlError('https://gh-proxy.com/')).toBeUndefined()
    expect(accelerateUrlError('http://mirror.example')).toBeUndefined()
    expect(accelerateUrlError('  https://gh-proxy.com/  ')).toBeUndefined()
  })

  it('flags empty and whitespace-only drafts as empty', () => {
    expect(accelerateUrlError('')).toBe('empty')
    expect(accelerateUrlError('   ')).toBe('empty')
  })

  it('rejects non-http(s) schemes', () => {
    expect(accelerateUrlError('gh-proxy.com')).toBe('invalid')
    expect(accelerateUrlError('ftp://mirror.example/')).toBe('invalid')
    expect(accelerateUrlError('file:///tmp/')).toBe('invalid')
  })

  it('rejects embedded whitespace before it can smuggle a second argument', () => {
    expect(accelerateUrlError('https://mirror.example/a b')).toBe('invalid')
    expect(accelerateUrlError('https://mirror.example/\t-x')).toBe('invalid')
  })
})

describe('normalizeAccelerateUrl', () => {
  it('trims and appends the trailing slash the prefix needs', () => {
    expect(normalizeAccelerateUrl('https://gh-proxy.com')).toBe('https://gh-proxy.com/')
    expect(normalizeAccelerateUrl('  https://gh-proxy.com/  ')).toBe('https://gh-proxy.com/')
    expect(normalizeAccelerateUrl('https://mirror.example/prefix/')).toBe('https://mirror.example/prefix/')
    expect(normalizeAccelerateUrl('https://mirror.example/prefix')).toBe('https://mirror.example/prefix/')
  })

  it('ships a default that is already a normalized prefix', () => {
    expect(ACCEL_DEFAULT_URL).toBe('https://gh-proxy.com/')
    expect(normalizeAccelerateUrl(ACCEL_DEFAULT_URL)).toBe(ACCEL_DEFAULT_URL)
  })
})

describe('remoteNameIssue', () => {
  it('accepts the names git itself allows', () => {
    expect(remoteNameIssue('origin')).toBeNull()
    expect(remoteNameIssue('up-stream_2.x')).toBeNull()
  })

  it('rejects empty, dash-leading and unusual names', () => {
    expect(remoteNameIssue('')).toBe('empty')
    expect(remoteNameIssue('  ')).toBe('empty')
    expect(remoteNameIssue('-origin')).toBe('leadingDash')
    expect(remoteNameIssue('ori gin')).toBe('illegal')
    expect(remoteNameIssue('origin.git')).toBeNull()
    expect(remoteNameIssue('.')).toBe('illegal')
    expect(remoteNameIssue('..')).toBe('illegal')
  })
})

describe('remoteUrlIssue', () => {
  it('accepts scheme URLs, scp-like addresses and absolute paths', () => {
    expect(remoteUrlIssue('https://github.com/o/r.git')).toBeUndefined()
    expect(remoteUrlIssue('git@github.com:o/r.git')).toBeUndefined()
    expect(remoteUrlIssue('ssh://git@host:2222/o/r.git')).toBeUndefined()
    expect(remoteUrlIssue('D:\\wt\\r')).toBeUndefined()
    expect(remoteUrlIssue('/srv/git/r.git')).toBeUndefined()
  })

  it('rejects an empty, whitespace or malformed address', () => {
    expect(remoteUrlIssue('')).toBe('empty')
    expect(remoteUrlIssue('   ')).toBe('empty')
    expect(remoteUrlIssue('-u')).toBe('invalid')
    expect(remoteUrlIssue('not a url')).toBe('whitespace')
    expect(remoteUrlIssue('origin')).toBe('invalid')
  })
})
