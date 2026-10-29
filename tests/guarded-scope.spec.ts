/**
 * Static gate for the busy-gate scope of guarded panel verbs. `runGuarded`
 * defaults to the working-tree scope: it lights `sectionBusy`, which the
 * uncommitted card renders as 「提交中…」 on the commit box's primary button.
 * A verb that only writes a TAG ref must pass `'repo'`, or the panel reports a
 * commit that is not happening (the reported bug behind decision 0027).
 *
 * The busy state is `useState` inside GitHistoryPanel, and the DSH client
 * packages only execute inside the dsh web host, so rendering the panel in a
 * standalone vitest is not an option — this spec parses the source with the
 * compiler API, the same approach as tests/jsx-order.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const SOURCE = resolve('src/client/GitHistoryPanel.tsx')

/** Verbs that write a tag ref only — neither end reads or writes the working
 * tree, so they must stay off the working-tree busy gate. */
const TAG_VERBS = ['requestCreateTag', 'requestPushTag'] as const

/** One `runGuarded(...)` call site: its verb body and its scope argument. */
interface GuardedCall {
  /** Source text of the first argument (the arrow function). */
  verb: string
  /** Source text of the second argument; undefined = the `'section'` default. */
  scope: string | undefined
  /** 1-based line of the call, for the failure message. */
  line: number
}

function guardedCalls(): GuardedCall[] {
  const file = ts.createSourceFile(SOURCE, readFileSync(SOURCE, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const calls: GuardedCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runGuarded') {
      const [verb, scope] = node.arguments
      calls.push({
        verb: verb === undefined ? '' : verb.getText(file),
        scope: scope === undefined ? undefined : scope.getText(file),
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

describe('runGuarded scope', () => {
  const calls = guardedCalls()

  it('finds every call site (the gate must not pass vacuously)', () => {
    expect(calls.length).toBeGreaterThan(0)
  })

  it('tag verbs pass the repo scope', () => {
    const tagCalls = calls.filter(call => TAG_VERBS.some(verb => call.verb.includes(verb)))
    // Both tag verbs exist today (create + push); a rename that drops one
    // should fail here rather than silently un-gate it.
    expect(tagCalls.map(call => TAG_VERBS.find(verb => call.verb.includes(verb))).sort()).toEqual(['requestCreateTag', 'requestPushTag'])
    for (const call of tagCalls) {
      expect(call.scope, `runGuarded call at line ${String(call.line)} must pass 'repo'`).toBe("'repo'")
    }
  })

  it('working-tree verbs keep the section default', () => {
    const others = calls.filter(call => !TAG_VERBS.some(verb => call.verb.includes(verb)))
    expect(others.length).toBeGreaterThan(0)
    for (const call of others) {
      expect(call.scope, `runGuarded call at line ${String(call.line)} must keep the default scope`).toBeUndefined()
    }
  })
})
