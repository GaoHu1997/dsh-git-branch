import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from '../src/git.ts'
import { parseProxyServer, proxyArgs, proxyUrlError, systemProxyUrl } from '../src/network-proxy.ts'

function result(partial: Partial<ExecResult>): ExecResult {
  return { code: 0, stdout: '', stderr: '', ...partial }
}

/** A `reg query` stand-in keyed by the value name it was asked about. */
function regExec(values: { enable?: ExecResult; server?: ExecResult }): Exec {
  return async (_file, args) => {
    if (args.includes('ProxyEnable')) return values.enable ?? result({ stdout: '    ProxyEnable    REG_DWORD    0x0\n' })
    if (args.includes('ProxyServer')) return values.server ?? result({ stdout: '' })
    return result({ stdout: '' })
  }
}

describe('proxyUrlError', () => {
  it('accepts the proxy shapes git can speak', () => {
    for (const url of ['http://127.0.0.1:7890', 'https://proxy.example:8443', 'socks5://127.0.0.1:1080', 'socks5h://127.0.0.1:1080/']) {
      expect(proxyUrlError(url)).toBeUndefined()
    }
  })

  it('rejects a bare host, an unsupported scheme, and a missing port', () => {
    expect(proxyUrlError('127.0.0.1:7890')).toContain('absolute proxy URL')
    expect(proxyUrlError('ftp://127.0.0.1:21')).toContain('scheme must be one of')
    expect(proxyUrlError('http://127.0.0.1')).toContain('proxy port')
  })

  it('rejects credentials, paths, queries, and out-of-range ports', () => {
    expect(proxyUrlError('http://user:secret@127.0.0.1:7890')).toContain('credentials')
    expect(proxyUrlError('http://127.0.0.1:7890/proxy')).toContain('path')
    expect(proxyUrlError('http://127.0.0.1:7890/?a=1')).toContain('path')
    expect(proxyUrlError('http://127.0.0.1:0')).toContain('1-65535')
    expect(proxyUrlError('http://127.0.0.1:70000')).toBeDefined()
  })
})

describe('proxyArgs', () => {
  it('routes one command through the proxy with a global -c', () => {
    expect(proxyArgs('http://127.0.0.1:7890')).toEqual(['-c', 'http.proxy=http://127.0.0.1:7890'])
  })
})

describe('parseProxyServer', () => {
  const line = (value: string): string => `HKEY_CURRENT_USER\\Internet Settings\r\n    ProxyServer    REG_SZ    ${value}\r\n\r\n`

  it('reads a plain host:port as an http proxy', () => {
    expect(parseProxyServer(line('127.0.0.1:7890'))).toBe('http://127.0.0.1:7890')
  })

  it('prefers the https entry of a per-scheme list', () => {
    expect(parseProxyServer(line('http=127.0.0.1:7890;https=127.0.0.1:7891'))).toBe('https://127.0.0.1:7891')
  })

  it('falls back to the http entry, then the first one', () => {
    expect(parseProxyServer(line('http=127.0.0.1:7890;ftp=127.0.0.1:21'))).toBe('http://127.0.0.1:7890')
    expect(parseProxyServer(line('ftp=127.0.0.1:21'))).toBe('http://127.0.0.1:21')
  })

  it('answers undefined for a missing line, an empty value, or a portless address', () => {
    expect(parseProxyServer('no such value\r\n')).toBeUndefined()
    expect(parseProxyServer(line(''))).toBeUndefined()
    expect(parseProxyServer(line('proxy.example'))).toBeUndefined()
  })
})

describe('systemProxyUrl', () => {
  it('reads an enabled proxy from the registry', async () => {
    const exec = regExec({
      enable: result({ stdout: '    ProxyEnable    REG_DWORD    0x1\n' }),
      server: result({ stdout: '    ProxyServer    REG_SZ    127.0.0.1:7890\n' }),
    })
    expect(await systemProxyUrl(exec, '.')).toBe('http://127.0.0.1:7890')
  })

  it('answers undefined when the switch is off, the read fails, or the value is unusable', async () => {
    expect(await systemProxyUrl(regExec({ enable: result({ stdout: '    ProxyEnable    REG_DWORD    0x0\n' }) }), '.')).toBeUndefined()
    expect(await systemProxyUrl(regExec({ enable: result({ code: 1, stderr: 'not found' }) }), '.')).toBeUndefined()
    expect(await systemProxyUrl(regExec({
      enable: result({ stdout: '    ProxyEnable    REG_DWORD    0x1\n' }),
      server: result({ stdout: '    ProxyServer    REG_SZ    proxy.example\n' }),
    }), '.')).toBeUndefined()
  })

  it('never invokes reg with anything but a read', async () => {
    const seen: string[][] = []
    const exec: Exec = async (_file, args) => {
      seen.push([...args])
      return result({ stdout: '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n' })
    }
    await systemProxyUrl(exec, '.')
    for (const args of seen) {
      expect(args[0]).toBe('query')
      expect(args).not.toContain('/s')
      expect(args).not.toContain('/d')
    }
  })
})
