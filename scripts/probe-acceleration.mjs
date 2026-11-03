/** Public, credential-free Git probes. Run with node scripts/probe-acceleration.mjs. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'dsh-acceleration-'))
const emptyConfig = join(root, 'empty.gitconfig')
await writeFile(emptyConfig, '')
// Ignore all injected Git configuration, helpers, headers and trace settings.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' })
const safeArgs = ['-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=15']
const repos = ['git/git.git', 'zhidian-cmd/gitport-github.git']
const cases = repos.flatMap(repo => [
  { name: `tangbai replace ${repo}`, url: `https://git.tangbai.cc/${repo}` },
  { name: `tangbai prepend ${repo}`, url: `https://git.tangbai.cc/https://github.com/${repo}` },
])
cases.push(
  { name: 'gh-proxy replace git/git.git', url: 'https://gh-proxy.com/git/git.git' },
  { name: 'gh-proxy prepend git/git.git', url: 'https://gh-proxy.com/https://github.com/git/git.git' },
  { name: 'github direct git/git.git', url: 'https://github.com/git/git.git' },
)
try {
  if (process.argv.includes('--fetch')) {
    const { accelArgs, fetchAll } = await import('../lib/git.js')
    const prefix = 'https://gh-proxy.com/'
    const upstream = 'https://github.com/octocat/Hello-World.git'
    await run('git', [...safeArgs, 'init', '-q'], { cwd: root, env })
    await run('git', [...safeArgs, 'remote', 'add', 'origin', upstream], { cwd: root, env })
    const started = Date.now()
    const isolatedExec = async (file, args, options) => {
      try {
        const { stdout, stderr } = await run(file, [...safeArgs, ...args], { cwd: options.cwd, env, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 })
        return { code: 0, stdout, stderr }
      } catch (error) {
        return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr || error.message }
      }
    }
    const { stdout: remoteHead } = await run('git', [...safeArgs, ...accelArgs(prefix), 'ls-remote', upstream, 'HEAD'], { cwd: root, env, timeout: 30000 })
    await fetchAll(isolatedExec, root, prefix)
    const { stdout: fetchedHead } = await run('git', ['rev-parse', 'refs/remotes/origin/master'], { cwd: root, env })
    const matches = remoteHead.split(/\s/)[0] === fetchedHead.trim()
    console.log(JSON.stringify({ testedAt: new Date().toISOString(), upstream, prefix, rewrite: accelArgs(prefix), fetchedHead: fetchedHead.trim(), matches, elapsedMs: Date.now() - started }, null, 2))
    if (!matches) process.exitCode = 1
  } else {
  const results = await Promise.all(cases.map(async entry => {
    const started = Date.now()
    try {
      const { stdout } = await run('git', [...safeArgs, 'ls-remote', entry.url, 'HEAD'], { cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024 })
      return { ...entry, ok: /^[0-9a-f]{40,64}\s+HEAD/m.test(stdout), elapsedMs: Date.now() - started, output: stdout.trim() }
    } catch (error) {
      return { ...entry, ok: false, elapsedMs: Date.now() - started, code: error.code, killed: error.killed, error: String(error.stderr || error.message).trim() }
    }
  }))
  console.log(JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
