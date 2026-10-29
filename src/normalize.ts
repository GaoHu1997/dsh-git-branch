/**
 * Pure name/URL normalization shared by the host (git command assembly,
 * config validation) and the client (forms). Windows-forbidden characters
 * govern worktree directory placement: a worktree folder name must survive
 * on every platform the host runs on.
 */

/**
 * Turn a branch display name into a single safe directory segment.
 * `feat/auth-login` → `feat-auth-login`; every Windows-forbidden character
 * (`<>:"|?*`, control chars) and `/` become `-`; runs of separators (`-`,
 * `.`, whitespace — so a `//` or a git-illegal `..` collapses too) merge to
 * one `-`; a single interior `.` survives (`v1.2.3` stays readable); trailing
 * dots and spaces (Windows-forbidden suffixes) are stripped; the result is
 * clamped to 64 characters and never empty or dash-only.
 * @param branch - branch display name (local or `remote/name` form).
 * @returns a safe single path segment.
 */
export function sanitizeBranchDir(branch: string): string {
  const replaced = branch.replace(/[<>:"/\\|?*\u0000-\u001f\s]/g, '-')
  const merged = replaced.replace(/[-.]{2,}/g, '-')
  const trimmed = merged.replace(/[.\s-]+$/, '')
  const clamped = trimmed.slice(0, 64).replace(/[.\s-]+$/, '')
  return clamped === '' || clamped.replaceAll('-', '') === '' ? 'branch' : clamped
}

/**
 * Local branch name for a display name: strip the leading `<remote>/` segment
 * when one is present (`origin/feat/x` → `feat/x`). A local branch whose own
 * name contains `/` (like `feat/x`) passes through unchanged — callers that
 * need certainty compare against the authoritative branch list instead.
 * @param branch - branch display name.
 * @returns the candidate local branch name.
 */
export function localBranchName(branch: string): string {
  const at = branch.indexOf('/')
  return at <= 0 ? branch : branch.slice(at + 1)
}

/**
 * Split a `<remote>/<name>` display name when it plausibly names a remote
 * branch: the first `/`-separated segment is treated as the remote.
 * @param branch - branch display name.
 * @returns the remote part and the local-twin name, or undefined when the
 * name has no `/` (a local branch or a bare word).
 */
export function splitRemoteBranch(branch: string): { remote: string; name: string } | undefined {
  const at = branch.indexOf('/')
  if (at <= 0) return undefined
  return { remote: branch.slice(0, at), name: branch.slice(at + 1) }
}

/**
 * Validate a user-configured worktree storage root: an absolute path on any
 * platform (POSIX `/…`, Windows drive `C:\…`/`C:/…`, or UNC `\\…`).
 * @param value - raw settings string.
 * @returns true when the value names an absolute path.
 */
export function isAbsoluteConfigPath(value: string): boolean {
  if (value === '') return false
  if (value.startsWith('/') || value.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

/** Why a user-typed NEW branch name is not acceptable yet (null = fine). */
export type BranchNameIssue = 'empty' | 'leadingDash' | 'illegal'

/**
 * Pre-flight check of a user-typed NEW branch name against git's ref-name
 * rules (git check-ref-format's reject list, the subset typing can hit):
 * non-empty; no leading `-` (git would parse it as a flag); no space, `~^:?*[\`
 * or control character; no `..`, `@{`, `//`, leading/trailing `/`; no component
 * starting with `.` or ending with `.lock`; no trailing `.`; not the lone `@`.
 * `git switch -c` stays the authority — a miss here surfaces through the
 * error envelope — this only feeds immediate form feedback.
 * @param name - raw draft text (NOT trimmed: a space is a real issue).
 * @returns the issue kind, or null when the name is acceptable.
 */
export function branchNameIssue(name: string): BranchNameIssue | null {
  if (name.trim() === '') return 'empty'
  if (name.startsWith('-')) return 'leadingDash'
  if (name === '@') return 'illegal'
  if (/[\s~^:?*[\\\u0000-\u001f]/.test(name)) return 'illegal'
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return 'illegal'
  if (name.startsWith('/') || name.endsWith('/')) return 'illegal'
  if (name.endsWith('.')) return 'illegal'
  if (/(^|\/)\./.test(name)) return 'illegal'
  if (/(^|\/)[^/]+\.lock($|\/)/.test(name)) return 'illegal'
  return null
}

/**
 * Shipped default for the cn-accelerate mirror prefix (the design doc's
 * `cnAccelerateUrl` default and the popover's「恢复默认」target).
 */
export const ACCEL_DEFAULT_URL = 'https://gh-proxy.com/'

/** Why a user-typed accelerate URL is not acceptable yet (undefined = fine). */
export type AccelerateUrlIssue = 'empty' | 'invalid'

/**
 * Pre-flight check of the cn-accelerate prefix against what the rewrite can
 * actually use: non-empty after trim, `http://` or `https://` scheme, and no
 * whitespace anywhere (a space would break the `url.<base>.insteadOf=<target>`
 * git config value and smuggle a second argument).
 * @param value - raw draft text.
 * @returns the issue kind, or undefined when the value is acceptable.
 */
export function accelerateUrlError(value: string): AccelerateUrlIssue | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return 'empty'
  if (/\s/.test(trimmed)) return 'invalid'
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return 'invalid'
  return undefined
}

/**
 * Normalize an accepted accelerate URL: trim, and append the trailing `/`
 * the prefix concatenation requires (`https://gh-proxy.com/` + `o/r.git`
 * must stay one valid URL). Callers pass the result to `url.<base>.insteadOf`.
 * @param value - an accepted (non-empty, http(s), whitespace-free) URL.
 * @returns the prefix ending in `/`.
 */
export function normalizeAccelerateUrl(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/** Why a user-typed REMOTE name is not acceptable yet (null = fine). */
export type RemoteNameIssue = 'empty' | 'leadingDash' | 'illegal'

/**
 * Pre-flight check of a remote name: non-empty; no leading `-` (git would
 * parse it as a flag); letters, digits, `.`, `_` and `-` only (`/`, space and
 * `~^:?*[\` are outside what a remote name can be typed as here); the lone
 * `.`/`..` are rejected. Git stays the authority — a miss surfaces through
 * the error envelope — this only feeds immediate form feedback.
 * @param name - raw draft text.
 * @returns the issue kind, or null when acceptable.
 */
export function remoteNameIssue(name: string): RemoteNameIssue | null {
  if (name.trim() === '') return 'empty'
  if (name.startsWith('-')) return 'leadingDash'
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'illegal'
  if (name === '.' || name === '..') return 'illegal'
  return null
}

/** Why a user-typed REMOTE URL is not acceptable yet (undefined = fine). */
export type RemoteUrlIssue = 'empty' | 'whitespace' | 'invalid'

/**
 * Pre-flight check of a remote URL. Accepted shapes: any `scheme://…` URL
 * (`https://`, `ssh://`, `git://`, `file://`), an scp-like
 * `user@host:path`, and an absolute local path (a legitimate `file` remote).
 * Everything else — a bare word, a URL with stray whitespace, a value git
 * would read as a flag — is rejected. Git validates the remote once added.
 * @param url - raw draft text.
 * @returns the issue kind, or undefined when acceptable.
 */
export function remoteUrlIssue(url: string): RemoteUrlIssue | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return 'empty'
  if (trimmed.startsWith('-')) return 'invalid'
  // Local-path remotes may contain spaces (`C:\my repo`), so the path shape
  // is classified before the whitespace rule.
  if (isAbsoluteConfigPath(trimmed)) return undefined
  if (/\s/.test(trimmed)) return 'whitespace'
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return undefined
  if (/^[^\s@/]+@[^\s:/]+:\S+$/.test(trimmed)) return undefined
  return 'invalid'
}
