import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IP_CACHE_TTL_MS,
  MAX_IP_CANDIDATES,
  candidateIpsFor,
  isOptimizableEndpoint,
  parseDohIps,
  pinArgs,
  pinnedChannelFor,
  racePinnedChannels,
  resetIpChannelCache,
  resolveHostIps,
} from '../src/network-ip.ts'

/** One DoH JSON body carrying `ips` as A records. */
function dohBody(ips: readonly string[]): string {
  return JSON.stringify({
    Status: 0,
    Answer: ips.map(data => ({ name: 'github.com', type: 1, TTL: 60, data })),
  })
}

/** A fetch stub answering with the given bodies in order. */
function stubFetch(bodies: readonly (string | number)[]): typeof fetch {
  let at = 0
  return (async () => {
    const body = bodies[Math.min(at, bodies.length - 1)]
    at += 1
    if (typeof body === 'number') return new Response('', { status: body })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  resetIpChannelCache()
})

describe('parseDohIps', () => {
  it('keeps only well-formed IPv4 answers and drops duplicates', () => {
    const payload = {
      Answer: [
        { type: 1, data: '20.205.243.166' },
        { type: 28, data: '2606:50c0:8000::153' },
        { type: 1, data: '20.205.243.166' },
        { type: 5, data: 'github.com' },
        { type: 1, data: '999.1.1.1' },
        { type: 1, data: 'not-an-ip' },
        { type: 1, data: '140.82.114.3' },
      ],
    }
    expect(parseDohIps(payload)).toEqual(['20.205.243.166', '140.82.114.3'])
  })

  it('answers no candidates for a malformed body instead of throwing', () => {
    expect(parseDohIps(null)).toEqual([])
    expect(parseDohIps({})).toEqual([])
    expect(parseDohIps({ Answer: 'nope' })).toEqual([])
    expect(parseDohIps({ Answer: [null, 3] })).toEqual([])
  })
})

describe('resolveHostIps', () => {
  it('unions every resolver that answered and skips the ones that did not', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(String(url))
      if (urls.length === 1) return new Response('', { status: 503 })
      return new Response(dohBody(['1.2.3.4']), { status: 200 })
    }) as unknown as typeof fetch
    expect(await resolveHostIps('github.com', fetchImpl)).toEqual(['1.2.3.4'])
    expect(urls[0]).toContain('alidns.com')
    expect(urls[1]).toContain('doh.pub')
  })

  it('answers no candidates when every resolver fails or answers empty', async () => {
    expect(await resolveHostIps('github.com', stubFetch([503, '{"Status":2}']))).toEqual([])
  })
})

describe('isOptimizableEndpoint', () => {
  it('accepts only https github.com', () => {
    expect(isOptimizableEndpoint('https://github.com/o/r.git')).toBe(true)
    expect(isOptimizableEndpoint('http://github.com/o/r.git')).toBe(false)
    expect(isOptimizableEndpoint('https://gh-proxy.com/https://github.com/o/r.git')).toBe(false)
    expect(isOptimizableEndpoint('https://gitlab.com/o/r.git')).toBe(false)
    expect(isOptimizableEndpoint('not a url')).toBe(false)
  })
})

describe('pinArgs', () => {
  it('pins host:443 to one IP with a global -c option', () => {
    expect(pinArgs('github.com', '140.82.114.3')).toEqual(['-c', 'http.curloptResolve=github.com:443:140.82.114.3'])
  })
})

describe('racePinnedChannels', () => {
  it('answers the first candidate whose probe actually succeeded', async () => {
    const probed: string[] = []
    const args = await racePinnedChannels(['10.0.0.1', '10.0.0.2', '10.0.0.3'], 'github.com', async candidate => {
      probed.push(candidate[1] ?? '')
      if (candidate[1]?.endsWith('10.0.0.2')) return
      throw new Error('reset')
    })
    expect(args).toEqual(['-c', 'http.curloptResolve=github.com:443:10.0.0.2'])
    expect(probed).toHaveLength(3)
  })

  it('probes no more than MAX_IP_CANDIDATES and answers undefined when all fail', async () => {
    let count = 0
    const args = await racePinnedChannels(
      Array.from({ length: 6 }, (_, index) => `10.0.0.${index + 1}`),
      'github.com',
      async () => {
        count += 1
        throw new Error('dead')
      },
    )
    expect(args).toBeUndefined()
    expect(count).toBe(MAX_IP_CANDIDATES)
  })
})

describe('pinnedChannelFor', () => {
  it('is skipped entirely for endpoints the channel may not rewrite', async () => {
    const probe = vi.fn(async () => {})
    expect(await pinnedChannelFor({ endpoint: 'https://gh-proxy.com/x', probe })).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })

  it('resolves, races, and then reuses the winning channel for the TTL', async () => {
    const fetchImpl = stubFetch([dohBody(['10.0.0.1', '10.0.0.2'])])
    const probe = vi.fn(async (args: readonly string[]) => {
      if (!args[1]?.endsWith('10.0.0.2')) throw new Error('reset')
    })
    let now = 1_000
    const first = await pinnedChannelFor({ endpoint: 'https://github.com/o/r.git', probe, fetchImpl, now: () => now })
    expect(first).toEqual(['-c', 'http.curloptResolve=github.com:443:10.0.0.2'])
    probe.mockClear()
    now += IP_CACHE_TTL_MS - 1
    expect(await pinnedChannelFor({ endpoint: 'https://github.com/o/r.git', probe, fetchImpl, now: () => now })).toEqual(first)
    expect(probe).not.toHaveBeenCalled()
    now += 2
    await pinnedChannelFor({ endpoint: 'https://github.com/o/r.git', probe, fetchImpl, now: () => now })
    expect(probe).toHaveBeenCalled()
  })

  it('answers undefined when DNS yields nothing', async () => {
    const probe = vi.fn(async () => {})
    expect(await pinnedChannelFor({
      endpoint: 'https://github.com/o/r.git',
      probe,
      fetchImpl: stubFetch(['{"Status":3}']),
    })).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('candidateIpsFor', () => {
  it('widens the pool for github.com across sibling services and dedupes', async () => {
    // One resolver answered exactly one edge for github.com in the field, and
    // that edge was dead; the sibling services answered others in the same range.
    const fetchImpl = (async (url: string) => {
      const host = new URL(String(url)).searchParams.get('name')
      const ips = host === 'github.com'
        ? ['1.1.1.1', '2.2.2.2']
        : host === 'api.github.com'
          ? ['2.2.2.2', '3.3.3.3']
          : ['4.4.4.4']
      return new Response(dohBody(ips), { status: 200 })
    }) as unknown as typeof fetch
    expect(await candidateIpsFor('github.com', fetchImpl)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'])
  })

  it('asks only about the endpoint host for anything else', async () => {
    const seen: unknown[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(String(url)).searchParams.get('name'))
      return new Response(dohBody(['5.5.5.5']), { status: 200 })
    }) as unknown as typeof fetch
    expect(await candidateIpsFor('gitlab.com', fetchImpl)).toEqual(['5.5.5.5'])
    expect(new Set(seen)).toEqual(new Set(['gitlab.com']))
  })

  it('caps the pool at MAX_IP_CANDIDATES', async () => {
    const many = ['1.0.0.1', '1.0.0.2', '1.0.0.3', '1.0.0.4', '1.0.0.5', '1.0.0.6', '1.0.0.7', '1.0.0.8']
    const fetchImpl = (async () => new Response(dohBody(many), { status: 200 })) as unknown as typeof fetch
    expect(await candidateIpsFor('github.com', fetchImpl)).toHaveLength(MAX_IP_CANDIDATES)
  })
})
