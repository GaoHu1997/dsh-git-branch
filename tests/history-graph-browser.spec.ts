/** Real Chromium geometry regression for history rails. Set PLAYWRIGHT_CHROMIUM
 * to a browser executable on CI; Windows also uses the installed Edge. */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { CommitEntry } from '../src/wire.ts'
import { HistorySection, type CommitFilesState, type HistorySectionProps } from '../src/client/panel/HistorySection.tsx'
import { EMPTY_HISTORY_FILTERS } from '../src/client/git-panel-data.ts'
import css from '../src/client/GitHistoryPanel.module.css'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : chromium.executablePath())
const stylesheet = readFileSync(resolve('src/client/GitHistoryPanel.module.css'), 'utf8')
  .replace(/\.([A-Za-z_][\w-]*)/g, (match, name: string) => css[name] === undefined ? match : `.${css[name]}`)

function commit(hash: string, parents: string[], refs: string[] = []): CommitEntry {
  return { hash, parents, refs, short: hash, subject: `Commit ${hash}`, body: '', authorName: 'Author', authorEmail: 'author@example.com', date: 1793073600000 }
}
// Three parents, a parallel unrelated tip, and convergence into a common base.
const commits = [
  commit('merge', ['main', 'side', 'third'], ['HEAD -> main', 'origin/main']),
  commit('main', ['base']),
  commit('tip', ['side']),
  commit('side', ['base']),
  commit('third', ['base']),
  commit('base', []),
]
const noop = (): void => {}
const baseProps: HistorySectionProps = {
  t: key => key,
  commits, loaded: true, loadError: undefined, loading: false,
  hasMore: false, loadingMore: false, expanded: null, filesByHash: {},
  filters: EMPTY_HISTORY_FILTERS, branches: ['main'], busy: false,
  onLoadMore: noop, onToggle: noop, onFilters: noop,
  onCreateBranch: noop, onCreateTag: noop, pushToast: noop,
}

/** This assertion intentionally compares screen coordinates, not SVG source:
 * padding, flex shrink, viewBox letterboxing and row gaps all affect them. */
async function assertConnected(page: Page): Promise<void> {
  const errors = await page.evaluate((classes) => {
    const failures: string[] = []
    type Point = { x: number; y: number }
    const close = (label: string, actual: number, expected: number): void => {
      if (Math.abs(actual - expected) > 0.5) failures.push(`${label}: ${actual} != ${expected}`)
    }
    const same = (label: string, left: Point[], right: Point[]): void => {
      const sorted = (points: Point[]): Point[] => points.sort((a, b) => a.x - b.x)
      sorted(left); sorted(right)
      if (left.length !== right.length) failures.push(`${label}: ${left.length} lanes != ${right.length}`)
      for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
        close(`${label} x`, left[i]!.x, right[i]!.x)
        close(`${label} y`, left[i]!.y, right[i]!.y)
      }
    }
    const endpoints = (svg: SVGSVGElement): { top: Point[]; bottom: Point[] } => {
      const rect = svg.getBoundingClientRect()
      const top: Point[] = []
      const bottom: Point[] = []
      for (const path of svg.querySelectorAll<SVGGeometryElement>('path,line')) {
        const matrix = path.getScreenCTM()!
        const start = path.getPointAtLength(0).matrixTransform(matrix)
        const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix)
        if (Math.abs(start.y - rect.top) < 0.5) top.push({ x: start.x, y: start.y })
        if (Math.abs(end.y - rect.bottom) < 0.5) bottom.push({ x: end.x, y: end.y })
      }
      return { top, bottom }
    }
    const rows = [...document.querySelectorAll<HTMLElement>(`.${classes.commitRow}`)]
    let previous: Point[] | undefined
    let previousBottom: number | undefined
    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect()
      const graph = row.querySelector<SVGSVGElement>(`.${classes.commitGraphSvg}`)!
      const graphRect = graph.getBoundingClientRect()
      const dot = row.querySelector<HTMLElement>(`.${classes.commitDot}`)!.getBoundingClientRect()
      const scale = Number(getComputedStyle(document.body).zoom) || 1
      close(`row ${index} header top`, graphRect.top, rect.top)
      close(`row ${index} dot width`, dot.width, 8 * scale)
      close(`row ${index} dot height`, dot.height, 8 * scale)
      close(`row ${index} dot center`, (dot.top + dot.bottom) / 2, (graphRect.top + graphRect.bottom) / 2)
      const header = endpoints(graph)
      if (previous !== undefined) same(`row ${index} boundary`, previous, header.top)
      if (previousBottom !== undefined) close(`row ${index} row gap`, rect.top, previousBottom)
      const continuation = row.querySelector<SVGSVGElement>(`.${classes.commitExpandGraph}`)
      if (continuation !== null) {
        const continuationRect = continuation.getBoundingClientRect()
        const expansion = endpoints(continuation)
        close(`row ${index} expansion top`, continuationRect.top, graphRect.bottom)
        same(`row ${index} expansion lanes`, header.bottom, expansion.top)
        close(`row ${index} expansion bottom`, continuationRect.bottom, rect.bottom)
        previous = expansion.bottom
      } else {
        close(`row ${index} header bottom`, graphRect.bottom, rect.bottom)
        previous = header.bottom
      }
      previousBottom = rect.bottom
    }
    if (rows.length < 2) failures.push('Expected multiple rendered history rows')
    return failures
  }, {
    commitRow: css.commitRow,
    commitGraphSvg: css.commitGraphSvg,
    commitDot: css.commitDot,
    commitExpandGraph: css.commitExpandGraph,
  })
  expect(errors).toEqual([])
}

async function render(page: Page, overrides: Partial<HistorySectionProps> = {}, extraCss = ''): Promise<void> {
  const markup = renderToStaticMarkup(createElement(HistorySection, { ...baseProps, ...overrides }))
  await page.setContent(`<html><head><style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #333; font: 14px/1.5 Arial, sans-serif; background: #fff; }
    #fixture { display: flex; flex-direction: column; height: 380px; padding: 12px; }
    ${stylesheet}
    ${extraCss}
    </style></head><body><main id="fixture">${markup}</main></body></html>`)
}

describe.skipIf(!existsSync(executablePath))('history graph browser geometry', () => {
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath, headless: true })
    page = await browser.newPage({ viewport: { width: 1100, height: 740 } })
  }, 20000)
  afterAll(async () => { await browser?.close() })

  it('joins actual endpoints for linear rows, merges and parallel tips', async () => {
    await render(page)
    await assertConnected(page)
    await render(page, { commits: [commit('c', ['b']), commit('b', ['a']), commit('a', [])] })
    await assertConnected(page)
  })

  const states: [string, CommitFilesState][] = [
    ['loading', { kind: 'loading' }],
    ['failed', { kind: 'failed', message: 'Cannot load files' }],
    ['empty', { kind: 'loaded', files: [] }],
    ['files', { kind: 'loaded', files: Array.from({ length: 18 }, (_, i) => ({ path: `src/file-${i}.ts`, status: 'M', insertions: i, deletions: 1 })) }],
  ]
  for (const [label, state] of states) {
    it(`continues every outgoing lane through expanded ${label}`, async () => {
      for (const expanded of ['merge', 'main', 'side', 'base']) {
        await render(page, { expanded, filesByHash: { [expanded]: state } })
        await assertConnected(page)
      }
    })
  }

  it('keeps alignment with tall text, narrow widths, zoom and pagination', async () => {
    await page.setViewportSize({ width: 620, height: 740 })
    await render(page, { commits: commits.slice(0, 3), hasMore: true }, 'body { zoom: 1.25; line-height: 2.8; }')
    await assertConnected(page)
    await render(page, { expanded: 'main', filesByHash: { main: states[3]![1] } }, 'body { zoom: 1.25; line-height: 2.8; }')
    await assertConnected(page)
    await page.setViewportSize({ width: 1100, height: 740 })
    await render(page, { expanded: 'merge', filesByHash: { merge: states[3]![1] } })
    await assertConnected(page)
    mkdirSync(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts/history-graph-fixed.png') })
  })
})
