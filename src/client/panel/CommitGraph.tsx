/**
 * Presentational lane gutter. Paths stretch to the actual row boundaries;
 * the dot is positioned separately so variable row heights do not distort it.
 * Expanded file lists carry the lanes leaving the row down to the next row.
 */

import type { GraphRow } from '../git-graph.ts'
import css from '../GitHistoryPanel.module.css'

/** Horizontal distance between lane centers, in px. */
export const LANE_PITCH = 14
/** Vertical coordinate system for curves, scaled to the actual row height. */
const GRAPH_BAND = 44
const LINE_WIDTH = 1.6

const LANE_COLORS: readonly string[] = [
  '#4c6bf5', '#2f9e44', '#e8590c', '#9c36b5',
  '#0c8599', '#d6336c', '#f08c00', '#5f3dc4',
]

export function laneColor(lane: number): string {
  return LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length] as string
}

function cx(lane: number): number {
  return lane * LANE_PITCH + LANE_PITCH / 2 + 2
}

function bend(from: number, fromY: number, to: number, toY: number): string {
  const x0 = cx(from)
  const x1 = cx(to)
  if (x0 === x1) return `M ${String(x0)} ${String(fromY)} L ${String(x1)} ${String(toY)}`
  const mid = (toY - fromY) / 2
  return `M ${String(x0)} ${String(fromY)} C ${String(x0)} ${String(fromY + mid)} ${String(x1)} ${String(toY - mid)} ${String(x1)} ${String(toY)}`
}

export interface CommitGraphProps {
  row: GraphRow
  /** Shared pixel width: every row uses the same horizontal coordinate system. */
  width: number
  merge: boolean
}

export function CommitGraph({ row, width, merge }: CommitGraphProps): JSX.Element {
  const mid = GRAPH_BAND / 2
  const dotColor = laneColor(row.lane)
  return (
    <>
      <svg
        className={css.commitGraphSvg}
        width={width}
        height="100%"
        viewBox={`0 0 ${String(width)} ${String(GRAPH_BAND)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {row.edges.map((edge, index) => {
          const [fromY, toY] = edge.kind === 'through'
            ? [0, GRAPH_BAND]
            : edge.kind === 'in' ? [0, mid] : [mid, GRAPH_BAND]
          return (
            <path
              key={`${edge.kind}:${String(edge.from)}:${String(edge.to)}:${String(index)}`}
              d={bend(edge.from, fromY, edge.to, toY)}
              fill="none"
              stroke={laneColor(edge.kind === 'out' ? edge.to : edge.from)}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>
      <span
        className={css.commitDot}
        style={{ left: cx(row.lane), color: dotColor, backgroundColor: merge ? 'transparent' : dotColor }}
        aria-hidden="true"
      />
    </>
  )
}

/** Only bottom-edge lanes continue through an expanded file list. Incoming
 * lanes already terminate at the dot and must not be resurrected below it. */
export function CommitGraphContinuation({ row, width }: Pick<CommitGraphProps, 'row' | 'width'>): JSX.Element {
  const lanes = [...new Set(row.edges.filter(edge => edge.kind !== 'in').map(edge => edge.to))]
  return (
    <svg className={css.commitExpandGraph} width={width} height="100%" aria-hidden="true" focusable="false">
      {lanes.map(lane => (
        <line
          key={lane}
          x1={cx(lane)}
          x2={cx(lane)}
          y1="0"
          y2="100%"
          stroke={laneColor(lane)}
          strokeWidth={LINE_WIDTH}
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}
