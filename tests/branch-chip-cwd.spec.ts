/**
 * The branch chip must inspect the Session's CURRENT directory.
 *
 * `summary.cwd` mirrors the Session header, which is frozen when the Session
 * starts. DSH's `working_directory` tool moves a Session through
 * `working-directory/change` and republishes the `workingDirectory` projection,
 * but the header stays put — so a chip reading only the header kept naming the
 * checkout the Session started in. Reported shape: a Session moved into a
 * worktree still displayed the main checkout's branch (`master`), and
 * refreshing never helped because nothing in that path was stale.
 *
 * The chip is not renderable under `renderToStaticMarkup` in a way that runs its
 * effects (they only mount in a live DOM, and this repo has no jsdom), so the
 * source decision is covered where it is decided: `resolveChipCwd`. The wiring
 * from that function to `useProjection('workingDirectory')` stays a one-liner in
 * the dock, and `tests/jsx-order.spec.ts` plus typecheck keep it honest.
 */
import { describe, expect, it } from 'vitest'
import { resolveChipCwd } from '../src/client/BranchChip.tsx'

/** Header directory: where the Session started, never updated. */
const HEADER_CWD = '/repo/main-checkout'
/** Effective directory after `working_directory` moved the Session. */
const MOVED_CWD = '/repo/branch-worktree'

describe('resolveChipCwd', () => {
  it('prefers the workingDirectory projection over the frozen header cwd', () => {
    // The reported bug: the Session moved, the header did not, so the chip
    // reported the original checkout's branch.
    expect(resolveChipCwd(MOVED_CWD, HEADER_CWD)).toBe(MOVED_CWD)
  })

  it('falls back to the header cwd while the projection has no value yet', () => {
    // No baseline/frame has carried the key: the Session never moved, so the
    // header is still correct and the chip must not go blank.
    expect(resolveChipCwd(undefined, HEADER_CWD)).toBe(HEADER_CWD)
    expect(resolveChipCwd(null, HEADER_CWD)).toBe(HEADER_CWD)
  })

  it('reports no directory when neither source knows one', () => {
    // A blank Session with no projection: the chip renders its idle state.
    expect(resolveChipCwd(undefined, undefined)).toBeUndefined()
  })
})
