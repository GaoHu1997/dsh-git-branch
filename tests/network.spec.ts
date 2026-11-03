import { describe, expect, it } from 'vitest'
import { classifyGitFailure, withHint } from '../src/network.ts'

describe('classifyGitFailure', () => {
  it('treats a killed command as a timeout, whatever its text says', () => {
    // The executor kills at the budget and the synthetic exit code carries no
    // verdict; the text may even look like a refusal.
    const failure = classifyGitFailure('fatal: the remote end hung up', { timedOut: true })
    expect(failure.kind).toBe('timeout')
    expect(failure.retryable).toBe(true)
    expect(failure.hint).toContain('verify before retrying a push')
  })

  it('reads a reset connection as a retryable reachability failure', () => {
    const failure = classifyGitFailure("fatal: unable to access 'https://github.com/o/r.git/': Recv failure: Connection was reset")
    expect(failure.kind).toBe('reset')
    expect(failure.retryable).toBe(true)
  })

  it('reads an unresolvable host as retryable but not a credential problem', () => {
    const failure = classifyGitFailure('fatal: unable to access: Could not resolve host: github.com')
    expect(failure.kind).toBe('unreachable')
    expect(failure.retryable).toBe(true)
  })

  it('never retries a credential failure', () => {
    // Retrying cannot conjure a token, and a silent retry would burn the
    // push budget on a host that will keep refusing.
    const failure = classifyGitFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")
    expect(failure.kind).toBe('credentials')
    expect(failure.retryable).toBe(false)
    expect(failure.hint).toContain('credentials panel')
  })

  it('names a proxy that refused the tunnel instead of blaming the host', () => {
    const failure = classifyGitFailure('fatal: unable to access: Failed to connect to github.com:443 over proxy 127.0.0.1 after 1 ms')
    expect(failure.kind).toBe('proxy')
    expect(failure.retryable).toBe(false)
  })

  it('never retries a non-fast-forward or a protected branch', () => {
    expect(classifyGitFailure('! [rejected] main -> main (non-fast-forward)').kind).toBe('diverged')
    expect(classifyGitFailure('remote: error: GH006: Protected branch update failed').kind).toBe('protected')
    expect(classifyGitFailure('! [remote rejected] main (pre-receive hook declined)').retryable).toBe(false)
  })

  it('answers unknown, with no hint, for text it does not recognise', () => {
    const failure = classifyGitFailure('fatal: something entirely new')
    expect(failure).toEqual({ kind: 'unknown', retryable: false, hint: undefined })
  })
})

describe('withHint', () => {
  it('keeps git diagnostic first and appends the hint once', () => {
    const failure = classifyGitFailure('fatal: unable to access: Connection was reset')
    const message = withHint('git push failed (exit 128): fatal: unable to access: Connection was reset', failure)
    expect(message.startsWith('git push failed')).toBe(true)
    expect(message.split('\n\n')).toHaveLength(2)
    expect(withHint(message, failure)).toBe(message)
  })

  it('returns the message untouched when the classifier has nothing to add', () => {
    const message = 'git push failed (exit 128): fatal: something entirely new'
    expect(withHint(message, classifyGitFailure('fatal: something entirely new'))).toBe(message)
  })
})
