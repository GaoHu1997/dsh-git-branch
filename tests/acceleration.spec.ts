import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { accelArgs } from '../src/git.ts'

// Ask real Git to expand the remote: argv-only assertions missed the original
// bug because both the implementation and its expected string dropped GitHub.
it('Git expands mirror prefixes to the complete upstream URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-accel-test-'))
  const config = join(root, 'empty.gitconfig')
  writeFileSync(config, '')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config })
  const git = (args: readonly string[]): string => execFileSync('git', [...args], { cwd: root, env, encoding: 'utf8' }).trim()
  try {
    git(['init', '-q'])
    git(['remote', 'add', 'origin', 'https://github.com/git/git.git'])
    for (const prefix of ['https://gh-proxy.com', 'https://gh-proxy.com/https://github.com/']) {
      expect(git([...accelArgs(prefix), 'remote', 'get-url', 'origin']))
        .toBe('https://gh-proxy.com/https://github.com/git/git.git')
    }
    expect(git([...accelArgs('https://git.tangbai.cc'), 'remote', 'get-url', 'origin']))
      .toBe('https://git.tangbai.cc/https://github.com/git/git.git')
    expect(git(['remote', 'get-url', 'origin'])).toBe('https://github.com/git/git.git')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
