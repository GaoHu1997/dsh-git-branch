/**
 * The third network channel: an explicit proxy, or the one Windows already
 * has configured.
 *
 * Why the registry matters: git links libcurl, and libcurl does NOT read the
 * WinINET/PAC settings that every browser on the machine honours. Measured on
 * 2026-11-03 with a dead local proxy: `git ls-remote` failed with
 * `Failed to connect to github.com:443 over proxy 127.0.0.1` the moment
 * `-c http.proxy=…` was passed, i.e. git honours the argv and ignores the
 * system setting entirely. A `gitport`-style tool bundles its own proxy; this
 * plugin instead borrows the user's, and needs a way to find it.
 */
import type { Exec } from './git.js'

import { proxyUrlError } from './normalize.js'

/** A registry read is local and cheap; it must not become the slowest step. */
export const SYSTEM_PROXY_TIMEOUT_MS = 3_000

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Re-exported so host callers keep one import site for the proxy rules. */
export { proxyUrlError }
/** The argv that routes one command through the proxy; `-c` precedes the subcommand. */
export function proxyArgs(url: string): readonly string[] {
  return ['-c', `http.proxy=${url}`]
}

/**
 * Parse the `ProxyServer` value WinINET stores, which is either `host:port` or
 * a per-scheme list like `http=host:port;https=host:port`. The https entry
 * wins; a plain value is used as is. Anything malformed answers undefined.
 * @param raw - stdout of `reg query … /v ProxyServer`.
 */
export function parseProxyServer(raw: string): string | undefined {
  const line = raw.split(/\r?\n/).find(item => /ProxyServer\s+REG_SZ/i.test(item))
  if (line === undefined) return undefined
  const value = line.replace(/^.*?ProxyServer\s+REG_SZ\s*/i, '').trim()
  if (value === '') return undefined
  if (!value.includes('=')) return value.includes(':') ? `http://${value}` : undefined
  const entries = value.split(';').map(item => item.trim()).filter(item => item !== '')
  const https = entries.find(item => /^https=/i.test(item))
  const chosen = https ?? entries.find(item => /^http=/i.test(item)) ?? entries[0]
  const address = chosen?.replace(/^[a-z]+=/i, '').trim()
  if (address === undefined || address === '' || !address.includes(':')) return undefined
  const scheme = https === undefined ? 'http' : 'https'
  return `${scheme}://${address}`
}

/**
 * The system proxy Windows already has configured, when it is enabled and
 * points somewhere usable; undefined otherwise (off Windows, disabled, empty,
 * or unparseable). Read-only: nothing here changes the machine's settings.
 * @param exec - executor seam.
 * @param cwd - directory for the `reg` calls.
 */
export async function systemProxyUrl(exec: Exec, cwd: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const enabled = await exec('reg', ['query', INTERNET_SETTINGS, '/v', 'ProxyEnable'], { cwd, timeoutMs: SYSTEM_PROXY_TIMEOUT_MS })
  if (enabled.code !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout)) return undefined
  const server = await exec('reg', ['query', INTERNET_SETTINGS, '/v', 'ProxyServer'], { cwd, timeoutMs: SYSTEM_PROXY_TIMEOUT_MS })
  if (server.code !== 0) return undefined
  const url = parseProxyServer(server.stdout)
  if (url === undefined) return undefined
  return proxyUrlError(url) === undefined ? url : undefined
}
