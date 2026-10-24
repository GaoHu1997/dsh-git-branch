/**
 * Cross-surface git-mutation notice. The composer chip and the git panel
 * each own a private /status snapshot; a checkout done in one surface must
 * not leave the other showing a branch git has already left. Module-level
 * listener list — every consumer loads this same client bundle, so a plain
 * singleton spans the chip and the panel without a host service.
 *
 * @module git-worktree/client/git-events
 */

type GitMutatedListener = () => void

const listeners = new Set<GitMutatedListener>()

/** Announce that a surface changed repository state (checkout, rename,
 * delete, create, commit, fetch, update, push). */
export function emitGitMutated(): void {
  for (const listener of [...listeners]) listener()
}

/** Subscribe; returns the unsubscribe function. */
export function onGitMutated(listener: GitMutatedListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
