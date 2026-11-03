/**
 * Channel diagnostics for the settings UI: one read of the endpoint per
 * channel, so a user whose network is failing can see WHICH path reaches
 * GitHub instead of guessing.
 *
 * A probe is the same judgement the write path makes (0041/0042), run on
 * demand: the channel is good only when `ls-remote` exits 0. A TCP-level
 * "reachable" proves nothing — measured on 2026-11-03, 7 of 8 GitHub edges
 * accepted a connection and still failed the read.
 *
 * @module git-worktree/network-probe
 */

import type { Exec } from './git.js'
import { PROBE_TIMEOUT_MS } from './network.js'
import type { NetworkChannelId, NetworkChannelReport } from './wire.js'

const DETAIL_LIMIT = 300

/**
 * Keep a failure readable in a toast: the first non-empty line, capped.
 * @param text - raw stderr or error message.
 */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find(item => item.trim() !== '') ?? ''
  return line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT)}…` : line
}

/**
 * Probe one channel by reading the endpoint through it.
 *
 * Failures are returned as data: a dead channel must not hide the next one,
 * and the caller renders every report side by side.
 * @param exec - executor seam.
 * @param cwd - any directory inside the repository.
 * @param channel - which channel this argv stands for.
 * @param url - endpoint to read.
 * @param channelArgs - the channel's argv prefix (empty for direct).
 * @param authArgs - credential argv for this host.
 * @returns the channel's verdict, failures included.
 */
export async function channelReport(
  exec: Exec,
  cwd: string,
  channel: NetworkChannelId,
  url: string,
  channelArgs: readonly string[],
  authArgs: readonly string[] = [],
): Promise<NetworkChannelReport> {
  const started = Date.now()
  const result = await exec('git', [...channelArgs, ...authArgs, 'ls-remote', '--heads', url], {
    cwd,
    timeoutMs: PROBE_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0' },
  })
  const elapsedMs = Date.now() - started
  if (result.code === 0) return { channel, ok: true, elapsedMs }
  return { channel, ok: false, elapsedMs, detail: firstLine(result.errorMessage ?? result.stderr) }
}
