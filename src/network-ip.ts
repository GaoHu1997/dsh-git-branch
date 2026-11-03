/**
 * The second network channel: resolve the host yourself, then race a few
 * edge IPs with a real `ls-remote` and pin the winner with
 * `http.curloptResolve`.
 *
 * Why a runtime lookup and not a built-in table: measured on 2026-11-03, a
 * static list of eight GitHub edge IPs had seven TCP-reachable but only four
 * that could answer `ls-remote`, two of them taking 88s and 211s. Edge
 * assignment moves; a table baked into a release rots. So the table is
 * fetched from DNS-over-HTTPS at the moment of need, and every candidate is
 * validated by the same command the push will run.
 *
 * TCP reachability is deliberately NOT the judge: `connect()` succeeding
 * says nothing about TLS termination or the git endpoint behind it.
 */
import type { Exec } from './git.js'

/** Budget for ONE pinned probe; candidates run in parallel, so the race is bounded by this. */
export const IP_PROBE_TIMEOUT_MS = 5_000
/** How long a winning channel is reused before the IPs are re-resolved. */
export const IP_CACHE_TTL_MS = 600_000
/**
 * Concurrent candidates. Probes run in parallel, so the wall clock is one
 * timeout no matter how many run; this only bounds process count.
 */
export const MAX_IP_CANDIDATES = 6

/** Hosts this channel applies to. A mirror or an enterprise host has its own DNS. */
const OPTIMIZABLE_HOSTS: readonly string[] = ['github.com']

/** DNS-over-HTTPS resolvers, tried in order until one answers. */
const DOH_URLS: readonly ((host: string) => string)[] = [
  host => `https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=A`,
  host => `https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=A`,
  host => `https://doh.360.cn/resolve?name=${encodeURIComponent(host)}&type=A`,
]

/**
 * Hostnames whose answers widen the candidate pool for `github.com`.
 *
 * Measured on 2026-11-03: `dns.alidns.com` answered a single address for
 * `github.com` (20.205.243.166) and `doh.pub` answered a different one
 * (140.82.112.3) — one resolver gives one edge, and that edge may be dead.
 * GitHub's edge fleet serves `api.`/`codeload.` from the same ranges, so their
 * answers are extra tickets in the same lottery. Every candidate still has to
 * answer a real `ls-remote` before it is used, so a wrong guess costs one
 * parallel probe and nothing else.
 */
const SIBLING_SOURCES: readonly string[] = ['api.github.com', 'codeload.github.com']

interface CachedChannel {
  args: readonly string[]
  at: number
}

const cache = new Map<string, CachedChannel>()

/** Drop every cached channel (tests, and a user-triggered re-probe). */
export function resetIpChannelCache(): void {
  cache.clear()
}

/**
 * Pull the IPv4 answers out of one DoH JSON body. Anything malformed answers
 * `[]` rather than throwing: a resolver hiccup must degrade to the direct
 * channel, not fail the push before it starts.
 */
export function parseDohIps(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const answer = (payload as { Answer?: unknown }).Answer
  if (!Array.isArray(answer)) return []
  const ips: string[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { type?: unknown; data?: unknown }
    if (record.type !== 1 || typeof record.data !== 'string') continue
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(record.data)) continue
    if (!record.data.split('.').every(part => Number(part) <= 255)) continue
    if (!ips.includes(record.data)) ips.push(record.data)
  }
  return ips
}

/** Budget for one DoH query. Three resolvers are asked in parallel, so this bounds resolution. */
export const DOH_TIMEOUT_MS = 3_000

/** One DoH question, or no answers (a blocked resolver is a normal state, not an error). */
async function askResolver(url: string, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    })
    if (!response.ok) return []
    return parseDohIps(await response.json())
  } catch {
    return []
  }
}

/**
 * Ask every resolver about one host, in parallel, and union the answers.
 *
 * Sequential fallback was measured to be the wrong shape: the resolvers that
 * are blocked here are blocked for the full timeout each, so a "fallback
 * chain" spends three timeouts to learn what one parallel round trip tells.
 * @param host - hostname to resolve.
 * @param fetchImpl - fetch seam (tests inject a stub).
 */
export async function resolveHostIps(host: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const answers = await Promise.all(DOH_URLS.map(url => askResolver(url(host), fetchImpl)))
  const ips: string[] = []
  for (const answer of answers) {
    for (const ip of answer) {
      if (!ips.includes(ip)) ips.push(ip)
    }
  }
  return ips
}

/**
 * Candidates to race for one endpoint: the endpoint's own answers first, then
 * the sibling services' answers (only for `github.com`), deduplicated and
 * capped at {@link MAX_IP_CANDIDATES}. Everything runs in parallel, so the
 * whole lookup is bounded by {@link DOH_TIMEOUT_MS}.
 * @param host - endpoint hostname.
 * @param fetchImpl - fetch seam.
 */
export async function candidateIpsFor(host: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const sources = host === 'github.com' ? [host, ...SIBLING_SOURCES] : [host]
  const answers = await Promise.all(sources.map(source => resolveHostIps(source, fetchImpl)))
  const ips: string[] = []
  for (const answer of answers) {
    for (const ip of answer) {
      if (!ips.includes(ip)) ips.push(ip)
    }
  }
  return ips.slice(0, MAX_IP_CANDIDATES)
}

/** Whether this endpoint is one the pinned-IP channel may rewrite. */
export function isOptimizableEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && OPTIMIZABLE_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * The argv that pins `host:443` to one IP for a single command. `-c` goes
 * before the subcommand, per git's global-option rule.
 */
export function pinArgs(host: string, ip: string): readonly string[] {
  return ['-c', `http.curloptResolve=${host}:443:${ip}`]
}

/** Seam for the race: resolves when the candidate answered `ls-remote`. */
export type Probe = (args: readonly string[]) => Promise<void>

/**
 * Race up to {@link MAX_IP_CANDIDATES} pinned channels and answer the argv of
 * the first that actually answers `ls-remote`. "First" means first to
 * SUCCEED: all candidates start together and a slow-but-working IP can beat
 * one that fails later.
 * @param ips - candidates in resolver order.
 * @param host - hostname being pinned.
 * @param probe - one pinned probe (the caller supplies the budget + argv).
 * @returns the winning `-c` argv, or undefined when every candidate failed.
 */
export async function racePinnedChannels(ips: readonly string[], host: string, probe: Probe): Promise<readonly string[] | undefined> {
  const candidates = ips.slice(0, MAX_IP_CANDIDATES)
  const results = await Promise.all(candidates.map(async ip => {
    const args = pinArgs(host, ip)
    try {
      await probe(args)
      return args
    } catch {
      return undefined
    }
  }))
  // Promise.all keeps resolver order, so a tie goes to the first answer.
  return results.find(item => item !== undefined)
}

/**
 * The channel a read/write may fall back to when the direct one fails in a
 * retryable way. Wraps resolution + race + caching; answers undefined for
 * endpoints outside {@link OPTIMIZABLE_HOSTS} or when nothing works.
 * @param options.endpoint - the URL the command would use.
 * @param options.probe - one pinned probe, built by {@link pinnedProbe}.
 * @param options.now - clock seam for the cache.
 * @param options.fetchImpl - DoH fetch seam.
 */
export async function pinnedChannelFor(options: {
  endpoint: string
  probe: Probe
  now?: () => number
  fetchImpl?: typeof fetch
}): Promise<readonly string[] | undefined> {
  const { endpoint, probe } = options
  if (!isOptimizableEndpoint(endpoint)) return undefined
  const host = new URL(endpoint).hostname
  const now = options.now ?? Date.now
  const cached = cache.get(endpoint)
  if (cached !== undefined && now() - cached.at < IP_CACHE_TTL_MS) return cached.args
  const ips = await candidateIpsFor(host, options.fetchImpl)
  if (ips.length === 0) return undefined
  const args = await racePinnedChannels(ips, host, probe)
  if (args !== undefined) cache.set(endpoint, { args, at: now() })
  return args
}

/**
 * Build the probe the race runs: one pinned `ls-remote` at the probe budget,
 * with terminal prompts disabled so a credentialed endpoint fails instead of
 * hanging on an invisible dialog.
 * @param exec - executor seam.
 * @param cwd - any directory inside the repository.
 * @param endpoint - URL being probed.
 * @param authArgs - per-host credential argv.
 */
export function pinnedProbe(exec: Exec, cwd: string, endpoint: string, authArgs: readonly string[] = []): Probe {
  return async args => {
    const result = await exec('git', [...args, ...authArgs, 'ls-remote', '--heads', endpoint], {
      cwd,
      timeoutMs: IP_PROBE_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })
    if (result.code !== 0) throw new Error(result.errorMessage ?? result.stderr ?? 'pinned probe failed')
  }
}
