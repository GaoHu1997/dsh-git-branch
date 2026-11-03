/**
 * Network policy for the host half: how long each remote operation may take,
 * what a failed one actually means, and how a push that timed out is
 * reconciled with the remote afterwards. Nothing here spawns a process — the
 * budgets and the classifier are plain data so both the git wrapper and the
 * routes can use them without a second seam.
 */

/**
 * Budget for one reachability probe (`ls-remote`): a probe exists to fail
 * FAST, so a dead host costs seconds, not the minutes a real transfer gets.
 */
export const PROBE_TIMEOUT_MS = 10_000
/**
 * Budget for the READ half of the network (fetch/update): a slow link with a
 * real pack transfer outruns the local default, so this is deliberately wide.
 */
export const FETCH_TIMEOUT_MS = 300_000
/**
 * Budget for the WRITE half (push/push-tag). Wider than fetch: a push that
 * is killed mid-transfer may already have updated the remote refs, and the
 * caller pays for that ambiguity with a verification round-trip.
 */
export const PUSH_TIMEOUT_MS = 600_000
/** Budget for the post-timeout reconciliation (`ls-remote` after a push). */
export const VERIFY_TIMEOUT_MS = 10_000

/** What a failed git network command most likely means. */
export type GitFailureKind =
  | 'timeout'
  | 'unreachable'
  | 'reset'
  | 'proxy'
  | 'tls'
  | 'credentials'
  | 'diverged'
  | 'protected'
  | 'unknown'

/** Diagnosis of one failed remote command. */
export interface GitFailure {
  /** The shape of the failure; the UI may key wording off it later. */
  kind: GitFailureKind
  /**
   * Whether another network channel (a pinned IP, a proxy) could plausibly
   * make the SAME command succeed. Credential, TLS, divergence and hook
   * failures are about state, not reachability, so they never retry.
   */
  retryable: boolean
  /** One sentence the caller may append to the toast; undefined = say nothing. */
  hint: string | undefined
}

/** Patterns are matched in order: the first hit wins. */
const RULES: readonly {
  kind: GitFailureKind
  retryable: boolean
  hint: string | undefined
  test: (text: string) => boolean
}[] = [
  {
    kind: 'proxy',
    retryable: false,
    hint: 'The configured proxy refused or failed the CONNECT tunnel; check the proxy address or turn it off.',
    test: text => /over proxy/i.test(text)
      || /Proxy CONNECT aborted/i.test(text)
      || /CONNECT tunnel failed/i.test(text)
      || /Received HTTP code 407/i.test(text),
  },
  {
    kind: 'credentials',
    retryable: false,
    hint: 'Git could not read usable credentials; sign in for this host in the credentials panel, then retry.',
    test: text => /terminal prompts disabled/i.test(text)
      || /could not read Username/i.test(text)
      || /Authentication failed/i.test(text)
      || /Permission denied \(publickey/i.test(text)
      || /HTTP 40[13]\b/.test(text),
  },
  {
    kind: 'unreachable',
    retryable: true,
    hint: 'The host could not be reached; retry, then pin an IP or use a proxy.',
    test: text => /Could not resolve host/i.test(text)
      || /Failed to connect/i.test(text)
      || /Could not connect to server/i.test(text)
      || /Connection refused/i.test(text)
      || /Network is unreachable/i.test(text),
  },
  {
    kind: 'reset',
    retryable: true,
    hint: 'The connection was reset mid-transfer; retry, then pin an IP or use a proxy.',
    test: text => /Connection was reset/i.test(text)
      || /Recv failure/i.test(text)
      || /RPC failed/i.test(text)
      || /early EOF/i.test(text)
      || /remote end hung up unexpectedly/i.test(text)
      || /unexpected disconnect/i.test(text),
  },
  {
    kind: 'tls',
    retryable: false,
    hint: 'TLS negotiation failed; the network is intercepting the connection or the certificate is untrusted.',
    test: text => /SSL certificate problem/i.test(text)
      || /schannel/i.test(text)
      || /SSL_ERROR/i.test(text)
      || /tlsv1 alert/i.test(text),
  },
  {
    kind: 'diverged',
    retryable: false,
    hint: 'The remote has commits you do not have; pull or rebase before pushing (the plugin never forces).',
    test: text => /non-fast-forward/i.test(text)
      || /fetch first/i.test(text)
      || /Not possible to fast-forward/i.test(text)
      || /\[rejected\]/i.test(text),
  },
  {
    kind: 'protected',
    retryable: false,
    hint: 'A server-side rule refused the update (protected branch or hook); resolve it on the host, not in the network.',
    test: text => /protected branch/i.test(text)
      || /hook declined/i.test(text)
      || /pre-receive hook/i.test(text),
  },
]

/**
 * Classify one failed git network command from its diagnostic text.
 * @param stderr - git's diagnostic (stderr, or the executor's fallback text).
 * @param options - `timedOut` when the executor killed the process at its
 * budget; that outranks the text, because a killed push carries no verdict.
 * @returns the kind, whether another channel may help, and a one-line hint.
 */
export function classifyGitFailure(stderr: string, options: { timedOut?: boolean } = {}): GitFailure {
  if (options.timedOut === true) {
    return {
      kind: 'timeout',
      retryable: true,
      hint: 'The command did not finish within its time budget; the remote may still be applying it — verify before retrying a push.',
    }
  }
  const text = stderr.trim()
  for (const rule of RULES) {
    if (rule.test(text)) return { kind: rule.kind, retryable: rule.retryable, hint: rule.hint }
  }
  return { kind: 'unknown', retryable: false, hint: undefined }
}

/**
 * Append a classified hint to git's own message, once: the raw diagnostic
 * stays first so the user can still copy it into a bug report.
 * @param message - the existing error text.
 * @param failure - classifier output.
 * @returns the message with the hint appended, unchanged when there is none.
 */
export function withHint(message: string, failure: GitFailure): string {
  if (failure.hint === undefined || message.includes(failure.hint)) return message
  return `${message}\n\n${failure.hint}`
}
