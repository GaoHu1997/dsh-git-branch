import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sessionGitconfigBody } from '../src/shell-bridge.ts'

// End-to-end over the real `git` binary (decision 0034). The unit tests cover
// the generated config's shape; this suite proves git actually RESOLVES it:
// the `!` helper runs despite a space-containing path, the URL-scope reset
// beats a helper the user config carries (the local `gh` case), and a host
// with no stored credential fails fast instead of opening a GUI dialog.
//
// The helpers here are tiny stand-ins for the shipped
// `lib/helpers/git-credential-bridge.js` so the suite needs no build step and
// no machine credential file — it verifies the CHANNEL. The shipped helper's
// file lookup is covered by the unit tests and by the real-helper probe
// recorded in 0034.
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/** A `!` helper that answers git with one fixed token. */
function writeHelper(path: string, token: string): void {
  writeFileSync(path, `process.stdout.write('username=oauth2\\npassword=${token}\\n')\n`, 'utf8')
}

/** Parse the `password=` line git echoes back from `credential fill`. */
function passwordOf(stdout: string): string {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('password=')) return line.slice('password='.length)
  }
  return ''
}

function fill(env: Record<string, string | undefined>, host: string) {
  return spawnSync('git', ['credential', 'fill'], {
    encoding: 'utf8',
    env,
    input: `protocol=https\nhost=${host}\n\n`,
  })
}

/** A clean env pointed at one session config, with any stale injection gone. */
function gitEnv(configPath: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_')) delete env[key]
  }
  env.GIT_CONFIG_GLOBAL = configPath
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

describe.skipIf(!gitAvailable)('session gitconfig channel (real git)', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-branch-e2e-'))
    const spaceDir = join(dir, 'space dir') // deliberate space: the quote pitfall
    mkdirSync(spaceDir)
    const bridgePath = join(spaceDir, 'bridge.js')
    writeHelper(bridgePath, 'BRIDGE_TOKEN')
    // A user config carrying a helper of its own for the same URL — the local
    // `gh` helper in the motivating case. The URL-scope reset must cut it.
    const userHelper = join(dir, 'user-helper.js')
    writeHelper(userHelper, 'WRONG_TOKEN')
    const userGitconfig = join(dir, 'user.gitconfig')
    writeFileSync(
      userGitconfig,
      `[credential "https://github.com/"]\n\thelper = !${JSON.stringify(process.execPath).slice(1, -1)} ${JSON.stringify(userHelper).slice(1, -1)}\n`,
      'utf8',
    )
    const configPath = join(dir, 'session.gitconfig')
    writeFileSync(
      configPath,
      sessionGitconfigBody(['github.com'], {
        nodePath: process.execPath,
        helperPath: bridgePath,
        userGitconfig,
      }),
      'utf8',
    )
    return { dir, configPath }
  }

  it('a stored host answers with the bridge token, not the user-config helper', () => {
    const { dir, configPath } = setup()
    try {
      const r = fill(gitEnv(configPath), 'github.com')
      expect(r.status).toBe(0)
      expect(passwordOf(r.stdout)).toBe('BRIDGE_TOKEN')
      expect(r.stdout).not.toContain('WRONG_TOKEN')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unlisted host fails fast (exit 128), never prompting', () => {
    const { dir, configPath } = setup()
    try {
      const r = fill(gitEnv(configPath), 'gitlab.com')
      expect(r.status).toBe(128)
      expect(r.stderr).toContain('terminal prompts disabled')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
