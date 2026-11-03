#!/usr/bin/env node
/**
 * Real-data network matrix for this plugin's git channels — no mocks.
 *
 *   node scripts/probe-network.mjs [--repo <dir>] [--mirror <prefix>] [--proxy <url>]
 *
 * Each candidate runs a genuine `git ls-remote --heads <endpoint>`, because TCP
 * reachability says nothing about TLS + auth + the git protocol (measured:
 * 7/8 GitHub edges accept a TCP connection, 4 answer git). Results are printed
 * as `ok/fail · channel · ms · detail`, mirroring what /network-probe returns
 * (decision 0043), so a user can paste the output into an issue.
 */
import { execFile } from 'node:child_process'

const args = process.argv.slice(2)
function flag(name, fallback = undefined) {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const repo = flag('repo', process.cwd())
const mirror = flag('mirror')
const proxy = flag('proxy')
const PROBE_MS = 12_000
const HOST = 'github.com'

function run(argv, timeoutMs = PROBE_MS) {
  const started = Date.now()
  return new Promise(resolve => {
    execFile('git', argv, {
      cwd: repo,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => resolve({
      ok: error === null,
      ms: Date.now() - started,
      detail: (error === null ? '' : String(stderr || error.message)).split('\n')[0].trim().slice(0, 160),
    }))
  })
}

async function endpoint() {
  const direct = await new Promise(resolve => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd: repo }, (error, stdout) => resolve(error === null ? stdout.trim() : ''))
  })
  return direct
}

const RESOLVERS = [
  name => `https://dns.alidns.com/resolve?name=${name}&type=A`,
  name => `https://doh.pub/dns-query?name=${name}&type=A`,
  name => `https://doh.360.cn/resolve?name=${name}&type=A`,
]
const SIBLINGS = ['api.github.com', 'codeload.github.com']

async function ask(build, name) {
  try {
    const response = await fetch(build(name), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3_000) })
    if (!response.ok) return []
    const body = await response.json()
    return (body.Answer ?? []).filter(answer => answer.type === 1).map(answer => answer.data)
  } catch {
    return []
  }
}

async function candidates() {
  const hosts = [HOST, ...SIBLINGS]
  const answers = await Promise.all(hosts.flatMap(name => RESOLVERS.map(build => ask(build, name))))
  const ips = [...new Set(answers.flat())].slice(0, 6)
  return ips
}

const rows = []
function report(channel, result) {
  rows.push({ channel, ...result })
}

const target = await endpoint()
if (target === '') {
  console.error(`no origin remote in ${repo}`)
  process.exit(2)
}
console.log(`endpoint ${target}\nrepo     ${repo}\n`)

report('direct', await run(['ls-remote', '--heads', target]))
if (mirror !== undefined) {
  report('mirror', await run(['-c', `url.${mirror}.insteadOf=https://github.com/`, 'ls-remote', '--heads', target]))
}
if (proxy !== undefined) {
  report('proxy', await run(['-c', `http.proxy=${proxy}`, 'ls-remote', '--heads', target]))
}
const ips = await candidates()
const races = await Promise.all(ips.map(ip => run(['-c', `http.curloptResolve=${HOST}:443:${ip}`, 'ls-remote', '--heads', target])))
ips.forEach((ip, index) => report(`ip:${ip}`, races[index]))

for (const row of rows) {
  const mark = row.ok ? 'ok  ' : 'fail'
  console.log(`${mark} · ${row.channel.padEnd(16)} · ${String(row.ms).padStart(6)} ms${row.detail === '' ? '' : ` · ${row.detail}`}`)
}

process.exit(rows.some(row => row.ok) ? 0 : 1)
