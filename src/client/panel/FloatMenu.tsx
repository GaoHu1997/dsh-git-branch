/**
 * FloatMenu: a body-portalled, fixed-positioned popup menu anchored to a
 * viewport point — the shared shell behind the branch list's context menu and
 * the history rows' commit menu.
 *
 * Owns the three things every such menu needs and neither caller should
 * re-implement: the portal (a scrolling card body would otherwise clip it),
 * dismissal (pointer-down outside + Escape), and viewport clamping in a
 * LAYOUT effect (measuring after paint would flash a menu off-screen, and the
 * clamp must run before the browser shows the frame).
 *
 * Position arrives as the anchor point in client coordinates — the caller
 * derives it from the row it was opened on, so the menu opens where the user
 * clicked rather than where the row happens to be after a re-render.
 *
 * @module git-worktree/client/panel/FloatMenu
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from '../GitHistoryPanel.module.css'

/** Distance kept from the viewport edges, in px. */
const VIEWPORT_MARGIN = 8

/** Where to open, in client coordinates: `{ left, top }` is the menu's own
 * top-left corner before clamping. */
export interface FloatAnchor {
  left: number
  top: number
}

/** Props of {@link FloatMenu}. */
export interface FloatMenuProps {
  anchor: FloatAnchor
  /** The menu's `role`: `menu` for actions, `dialog` for a form popup. */
  role?: 'menu' | 'dialog'
  /** Accessible name, when the menu's own head is not descriptive enough. */
  label?: string
  onClose: () => void
  children: ReactNode
}

/**
 * One floating menu. Rendered into `document.body`, positioned on the layout
 * pass and clamped into the viewport: flip above the anchor when the menu
 * would overflow the bottom, clamp the left edge otherwise.
 */
export function FloatMenu(props: FloatMenuProps): JSX.Element {
  const { anchor, role = 'menu', label, onClose, children } = props
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - rect.width - VIEWPORT_MARGIN))
    let top = anchor.top
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, anchor.top - rect.height - VIEWPORT_MARGIN)
    }
    el.style.left = `${String(Math.round(left))}px`
    el.style.top = `${String(Math.round(top))}px`
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className={`${css.menu} ${css.floatMenu}`}
      role={role}
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      {children}
    </div>,
    document.body,
  )
}
