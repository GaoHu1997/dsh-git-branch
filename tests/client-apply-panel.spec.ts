/**
 * Git panel registration tests: the entry card lives in the dsh-better-sidebar
 * right sidebar, registered through `ctx.betterSidebar.registerTab` behind a
 * `ctx.inject(['betterSidebar'])` wait — an OPTIONAL dependency. The two
 * behaviors to pin: without the better-sidebar plugin the registration never
 * fires while the chip still registers, and with it present the descriptor
 * carries the git-history tab (single instance, thunked title/description,
 * component function).
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'
import { FakeCtx } from './client-apply.spec.ts'

type ApplyCtx = Parameters<typeof apply>[0]

describe('git panel registration', () => {
  it('registers nothing without the better-sidebar service; the chip is unaffected', () => {
    const ctx = new FakeCtx()
    const registrations: Array<Record<string, unknown>> = []
    ctx.betterSidebar = { registerTab: (descriptor) => { registrations.push(descriptor); return () => {} } }
    apply(ctx as unknown as ApplyCtx)
    expect(registrations).toEqual([])
    expect(ctx.slotNames).toContain('conversation.input.left')
  })

  it('registers the git-history tab through the betterSidebar service', () => {
    const ctx = new FakeCtx()
    const registrations: Array<Record<string, unknown>> = []
    ctx.services.add('betterSidebar')
    ctx.betterSidebar = { registerTab: (descriptor) => { registrations.push(descriptor); return () => {} } }
    apply(ctx as unknown as ApplyCtx)
    expect(registrations).toHaveLength(1)
    const descriptor = registrations[0] as {
      id: string
      title: () => string
      description: () => string
      order?: number
      single?: boolean
      component: (props: { scope: { sessionId: string; cwd?: string } }) => unknown
    }
    expect(descriptor.id).toBe('git-history')
    expect(descriptor.single).toBe(true)
    expect(descriptor.order).toBe(150)
    expect(descriptor.title()).toBe('panel.nav')
    expect(descriptor.description()).toBe('panel.description')
    expect(typeof descriptor.component).toBe('function')
    // The component renders from the tab scope alone.
    const node = descriptor.component({ scope: { sessionId: 's1', cwd: '/repo' } })
    expect(node).toBeDefined()
  })
})
