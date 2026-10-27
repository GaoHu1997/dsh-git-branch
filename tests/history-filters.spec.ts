/**
 * History filter tests: the time picker's windows, the date-input parsing, and
 * the request the card ships for one filter state.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_HISTORY_FILTERS, historyFilterBound, historyQueryFor, historyRangeBound, parseDayEnd, parseDayStart,
} from '../src/client/git-panel-data.ts'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const WEEK = 7 * DAY

describe('historyRangeBound', () => {
  it('resolves the relative windows against the request time', () => {
    expect(historyRangeBound('day', NOW)).toEqual({ since: NOW - DAY })
    expect(historyRangeBound('week', NOW)).toEqual({ since: NOW - WEEK })
    expect(historyRangeBound('all', NOW)).toEqual({})
  })

  it('passes a custom window through, open on either side', () => {
    expect(historyRangeBound('custom', NOW, { since: 5 })).toEqual({ since: 5 })
    expect(historyRangeBound('custom', NOW, { until: 9 })).toEqual({ until: 9 })
    expect(historyRangeBound('custom', NOW)).toEqual({})
  })
})

describe('parseDayStart / parseDayEnd', () => {
  it('reads a date input in the browser zone, not as UTC midnight', () => {
    const midnight = new Date(2026, 9, 15).getTime()
    expect(parseDayStart('2026-10-15')).toBe(midnight)
    expect(parseDayEnd('2026-10-15')).toBe(midnight + DAY - 1)
  })

  it('tolerates surrounding whitespace and rejects anything else', () => {
    expect(parseDayStart(' 2026-10-15 ')).toBe(new Date(2026, 9, 15).getTime())
    expect(parseDayStart('')).toBeUndefined()
    expect(parseDayStart('15/10/2026')).toBeUndefined()
    expect(parseDayEnd('2026-10')).toBeUndefined()
  })
})

describe('historyFilterBound', () => {
  it('uses the picker window unless the choice is custom', () => {
    expect(historyFilterBound({ ...EMPTY_HISTORY_FILTERS, range: 'week' }, NOW)).toEqual({ since: NOW - WEEK })
    expect(historyFilterBound(EMPTY_HISTORY_FILTERS, NOW)).toEqual({})
  })

  it('makes the custom window inclusive of its last day', () => {
    const filters = {
      ...EMPTY_HISTORY_FILTERS,
      range: 'custom' as const,
      customSince: '2026-10-01',
      customUntil: '2026-10-02',
    }
    expect(historyFilterBound(filters, NOW)).toEqual({
      since: new Date(2026, 9, 1).getTime(),
      until: new Date(2026, 9, 2).getTime() + DAY - 1,
    })
  })
})

describe('historyQueryFor', () => {
  it('asks for every ref by default, so merges can be drawn', () => {
    expect(historyQueryFor(EMPTY_HISTORY_FILTERS, NOW, 50, 0)).toEqual({ all: true, limit: 50, skip: 0 })
  })

  it('pins the ref and drops all once a branch is chosen', () => {
    const query = historyQueryFor({ ...EMPTY_HISTORY_FILTERS, branch: 'feat/x' }, NOW, 50, 100)
    expect(query).toEqual({ ref: 'feat/x', limit: 50, skip: 100 })
    expect(query).not.toHaveProperty('all')
  })

  it('trims the author and carries the resolved window', () => {
    expect(historyQueryFor({ ...EMPTY_HISTORY_FILTERS, author: '  Ann  ', range: 'day' }, NOW, 50, 0))
      .toEqual({ author: 'Ann', since: NOW - DAY, all: true, limit: 50, skip: 0 })
  })

  it('leaves a blank author out of the request', () => {
    expect(historyQueryFor({ ...EMPTY_HISTORY_FILTERS, author: '   ' }, NOW, 50, 0))
      .toEqual({ all: true, limit: 50, skip: 0 })
  })
})