/**
 * Git-graph lane layout for the history card — a pure function, no React and
 * no DOM, so the lane math is unit-testable on plain objects.
 *
 * The graph is derived from `parents` alone, which is why the history request
 * asks git for `--topo-order`: with a plain date order a branch's commits can
 * appear before their merge base, and an edge would then point at a row that
 * has not been painted yet (a line into nowhere).
 *
 * Layout is one forward pass over the (already newest-first) commit list:
 *
 *   - `lanes[i]` holds the hash lane `i` is currently "waiting for" — the
 *     commit that will terminate it. A tip starts a new lane; a commit sits in
 *     the lane already waiting for it, or takes the first free one.
 *   - Every lane waiting for THIS commit converges into its dot ('in'), the
 *     first parent continues from the dot in the commit's own lane, and extra
 *     parents (a merge) open or join a lane ('out'). Lanes nobody waits for
 *     anymore are released, so the graph reuses columns instead of growing
 *     with history length.
 *
 * Pagination recomputes over the whole accumulated list, so appending a page
 * keeps the lanes continuous across the page boundary.
 *
 * @module git-worktree/client/git-graph
 */

/** One commit the graph is computed from. */
export interface GraphCommit {
  readonly hash: string
  readonly parents: readonly string[]
}

/** A line segment crossing one row's band. */
export interface GraphEdge {
  /** `through` = a lane passing the row untouched (top edge → bottom edge);
   * `in` = converging from the top edge into this row's dot; `out` = leaving
   * the dot towards the bottom edge. */
  readonly kind: 'through' | 'in' | 'out'
  /** Lane index the segment starts at (top edge for `through`/`in`, the dot
   * for `out`). */
  readonly from: number
  /** Lane index the segment ends at (bottom edge for `through`/`out`, the dot
   * for `in`). */
  readonly to: number
}

/** One commit row's geometry. */
export interface GraphRow {
  /** Lane carrying this commit's dot. */
  readonly lane: number
  /** Lanes this row needs (widest occupied index + 1, at least 1). */
  readonly lanes: number
  readonly edges: readonly GraphEdge[]
}

/** Lanes waiting for a commit: hash per lane, `null` = free. */
type LaneState = (string | null)[]

/** Lazily extend `lanes` so `index` exists. */
function ensureLane(lanes: LaneState, index: number): void {
  while (lanes.length <= index) lanes.push(null)
}

/** First free lane, appended when every existing lane is busy. */
function takeLane(lanes: LaneState): number {
  const free = lanes.indexOf(null)
  if (free >= 0) return free
  lanes.push(null)
  return lanes.length - 1
}

/**
 * Compute one row per commit, in the order given.
 * @param commits - newest-first commits (git log order).
 * @returns one {@link GraphRow} per input commit, same order.
 */
export function buildGraph(commits: readonly GraphCommit[]): readonly GraphRow[] {
  /** Lane state at the TOP edge of the current row. */
  const lanes: LaneState = []
  const rows: GraphRow[] = []

  for (const commit of commits) {
    // Lanes already waiting for this commit converge into it; a commit nobody
    // waits for is a tip (usually HEAD's branch) and claims a free lane.
    const incoming: number[] = []
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] === commit.hash) incoming.push(index)
    }
    const converge = incoming[0]
    const lane: number = converge === undefined ? takeLane(lanes) : converge
    ensureLane(lanes, lane)
    if (converge === undefined) incoming.push(lane)

    // Snapshot the top edge before the lanes are reshuffled for the parents.
    const top = lanes.slice()
    for (const index of incoming) lanes[index] = null

    // Parents: the first continues straight down the commit's own lane, the
    // rest join the lane already waiting for them or open a new one.
    const parentLanes: number[] = []
    for (let position = 0; position < commit.parents.length; position += 1) {
      const parent = commit.parents[position] as string
      let target: number
      if (position === 0) {
        target = lane
        ensureLane(lanes, target)
      } else {
        const waiting = lanes.indexOf(parent)
        target = waiting >= 0 ? waiting : takeLane(lanes)
      }
      lanes[target] = parent
      if (!parentLanes.includes(target)) parentLanes.push(target)
    }

    // Edges: untouched lanes run straight through, every other lane bends.
    const edges: GraphEdge[] = []
    for (let index = 0; index < Math.max(top.length, lanes.length); index += 1) {
      const above = top[index] ?? null
      const below = lanes[index] ?? null
      if (above === null) continue
      if (below === above && index !== lane) {
        edges.push({ kind: 'through', from: index, to: index })
        continue
      }
      edges.push({ kind: 'in', from: index, to: lane })
    }
    for (const target of parentLanes) {
      edges.push({ kind: 'out', from: lane, to: target })
    }

    rows.push({ lane, lanes: Math.max(top.length, lanes.length), edges })
  }

  return trimWidths(rows)
}

/**
 * Narrow each row to the lanes it actually uses: a lane released midway (or
 * one opened only by a later commit) would otherwise reserve dead space in
 * every row above it.
 */
function trimWidths(rows: readonly GraphRow[]): readonly GraphRow[] {
  const widths = rows.map(row => {
    let width = 0
    for (const edge of row.edges) width = Math.max(width, edge.from + 1, edge.to + 1)
    return Math.max(width, row.lane + 1)
  })
  return rows.map((row, index) => ({ ...row, lanes: widths[index] ?? 1 }))
}

/** The widest row of a graph — how many lane columns the gutter needs. */
export function graphWidth(rows: readonly GraphRow[]): number {
  return rows.reduce((widest, row) => Math.max(widest, row.lanes), 1)
}
