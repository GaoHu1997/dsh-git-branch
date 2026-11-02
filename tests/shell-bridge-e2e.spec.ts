import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createLocalCredentialStore, formatCredentialLine } from '../src/credentials.ts'
import { createShellBridge } from '../src/shell-bridge.ts'

// End-to-end over the real `git` binary (decision 0037). The unit tests cover
// the generated include and gitconfig edits; this suite proves git actually
// RESOLVES them: `~/.git-credentials` answers for a managed host even though
// the user config installs a different helper for the same URL (the local
// `gh` / GCM situation), an unmanaged host keeps the user's own behaviour,
// and a missing credential fails fast instead of opening a GUI dialog.
//
// Everything runs in a throwaway HOME with the system config disabled, so the
// suite never reads or writes the machine's real credential files.
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/** A `!` helper that answers git with one fixed token — stands in for `gh`. */
function writeHelper(path: string, token: string): void {
  writeFileSync(path, `process.stdout.write('username=usertoken\\npassword=${token}\\n')\n`, 'utf8')
}

/** Parse the `password=` line git echoes back from `credential fill`. */
function passwordOf(stdout: string): string {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('password=')) return line.slice('password='.length)
  }
  return ''
}

/** A git config value command, quoted the way git's `!` shell needs. */
function helperCommand(scriptPath: string): string {
  const quote = (value: string): string => JSON.stringify(value).slice(1, -1)
  return `!${quote(process.execPath)} ${quote(scriptPath)}`
}

describe.skipIf(!gitAvailable)('local credential channel (real git)', () => {
  /** Build an isolated HOME with a competing user helper, then run the bridge. */
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-branch-e2e-'))
    const home = join(dir, 'home')
    const envHome = join(dir, 'dsh')
    mkdirSync(home)

    // The user's own helper for github.com — the local `gh` helper in the
    // motivating case. The plugin's URL-scoped section must beat it.
    const userHelper = join(dir, 'user-helper.js')
    writeHelper(userHelper, 'USER_TOKEN')
    const gitconfig = join(home, '.gitconfig')
    writeFileSync(
      gitconfig,
      `[credential "https://github.com/"]\n\thelper =\n\thelper = ${helperCommand(userHelper)}\n`,
      'utf8',
    )

    // What the panel writes: the machine credential file in git's store format.
    const credentialsFile = join(home, '.git-credentials')
    writeFileSync(
      credentialsFile,
      `${formatCredentialLine({ host: 'github.com', username: '', secret: 'STORE_TOKEN', method: 'token', updatedAt: 1 })}\n`,
      'utf8',
    )

    const env: Record<string, string | undefined> = {}
    const bridge = createShellBridge({
      home: () => home,
      envHome: () => envHome,
      store: createLocalCredentialStore(home, envHome),
      env,
    })

    /** A clean git environment pointed at this throwaway HOME. */
    const gitEnv = (): Record<string, string | undefined> => {
      const clean: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GIT_CONFIG_')) clean[key] = value
      }
      clean.HOME = home
      clean.USERPROFILE = home
      clean.GIT_CONFIG_GLOBAL = gitconfig
      // Keep the machine's system config (and its helper chain) out of the run.
      clean.GIT_CONFIG_NOSYSTEM = '1'
      clean.GIT_TERMINAL_PROMPT = '0'
      clean.GCM_INTERACTIVE = 'never'
      return clean
    }

    return {
      dir,
      home,
      gitconfig,
      credentialsFile,
      bridge,
      gitEnv,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  }

  function fill(env: Record<string, string | undefined>, host: string) {
    return spawnSync('git', ['credential', 'fill'], {
      encoding: 'utf8',
      env,
      input: `protocol=https\nhost=${host}\n\n`,
    })
  }

  it('answers with the stored credential, beating the user-config helper', async () => {
    const box = setup()
    try {
      await box.bridge.apply()

      const r = fill(box.gitEnv(), 'github.com')
      expect(r.status).toBe(0)
      expect(passwordOf(r.stdout)).toBe('STORE_TOKEN')
      expect(r.stdout).toContain('username=oauth2')
      expect(r.stdout).not.toContain('USER_TOKEN')
    } finally {
      box.cleanup()
    }
  })

  it('leaves an unmanaged host to the machine configuration', async () => {
    const box = setup()
    try {
      await box.bridge.apply()

      const r = fill(box.gitEnv(), 'gitlab.com')
      expect(r.status).toBe(128)
      expect(r.stderr).toContain('terminal prompts disabled')
    } finally {
      box.cleanup()
    }
  })

  it('dispose hands the host back to the user configuration', async () => {
    const box = setup()
    const helpers = (): string => spawnSync(
      'git',
      ['config', '--global', '--includes', '--get-all', 'credential.https://github.com/.helper'],
      { encoding: 'utf8', env: box.gitEnv() },
    ).stdout
    try {
      await box.bridge.apply()
      expect(readFileSync(box.gitconfig, 'utf8')).toContain('[include]')
      expect(helpers()).toContain('store')

      await box.bridge.dispose()
      expect(readFileSync(box.gitconfig, 'utf8')).not.toContain('[include]')
      expect(helpers()).not.toContain('store')
      // The credentials belong to the user: teardown never deletes them.
      expect(existsSync(box.credentialsFile)).toBe(true)
      expect(readFileSync(box.credentialsFile, 'utf8')).toContain('STORE_TOKEN')

      const r = fill(box.gitEnv(), 'github.com')
      expect(passwordOf(r.stdout)).not.toBe('STORE_TOKEN')
    } finally {
      box.cleanup()
    }
  })
})
