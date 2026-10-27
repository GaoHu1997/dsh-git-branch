/**
 * History-graph layout tests: lane assignment, edge kinds (straight through,
 * bending in from above, branching out below), and the widest column count the
 * gutter reserves.
 */

import { describe, expect, it } from 'vitest'
import { buildGraph, graphWidth } from '../src/client/git-graph.ts'

describe('buildGraph', () => {
  it('keeps a linear history in one lane', () => {
    const rows = buildGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
    expect(graphWidth(rows)).toBe(1)
    for (const row of rows) {
      for (const edge of row.edges) expect([edge.from, edge.to]).toEqual([0, 0])
    }
    // The oldest row has nothing above it to bend in from.
    expect(rows[2]?.edges.map(edge => edge.kind)).toEqual(['in'])
  })

  it('opens a lane for the second parent and folds it back at the fork point', () => {
    const rows = buildGraph([
      { hash: 'm', parents: ['a', 'b'] },
      { hash: 'a', parents: ['base'] },
      { hash: 'b', parents: ['base'] },
      { hash: 'base', parents: [] },
    ])
    // The merge commit branches out to the side column...
    expect(rows[0]?.edges).toContainEqual({ kind: 'out', from: 0, to: 1 })
    // ...the side branch runs straight down its own column...
    expect(rows[1]?.edges).toContainEqual({ kind: 'through', from: 1, to: 1 })
    // ...and the fork point bends that column back into the trunk.
    expect(rows[3]?.edges).toContainEqual({ kind: 'in', from: 1, to: 0 })
    expect(graphWidth(rows)).toBe(2)
  })

  it('gives a parentless tip no edge above it', () => {
    expect(buildGraph([{ hash: 'solo', parents: [] }])).toEqual([{ lane: 0, lanes: 1, edges: [] }])
  })

  it('reuses a column once its branch has been walked out', () => {
    const rows = buildGraph([
      { hash: 'x', parents: ['a'] },
      { hash: 'a', parents: [] },
      { hash: 'y', parents: [] },
    ])
    // The second unrelated tip takes the freed column instead of widening.
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
    expect(graphWidth(rows)).toBe(1)
  })

  it('does not reserve width for a column opened only further down', () => {
    const rows = buildGraph([
      { hash: 'a', parents: [] },
      { hash: 'b', parents: ['c', 'd'] },
      { hash: 'c', parents: [] },
      { hash: 'd', parents: [] },
    ])
    expect(rows[0]?.lanes).toBe(1)
    expect(rows[1]?.lanes).toBe(2)
    expect(graphWidth(rows)).toBe(2)
  })

  it('handles an empty history', () => {
    expect(buildGraph([])).toEqual([])
    expect(graphWidth([])).toBe(1)
  })
})