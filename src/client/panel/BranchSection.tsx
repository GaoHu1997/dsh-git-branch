/**
 * BranchSection: the panel's middle block — the branch list with an IDEA-style
 * action menu. Clicking any row opens a small menu anchored to it (checkout,
 * new branch from here, rename, delete, copy name — remote rows narrow it to
 * the actions a remote branch can take); the CURRENT branch's menu hides only
 * checkout and delete, so rename/new-from/copy stay reachable. Rename and
 * create run through the Modal primitive with the same client-side name
 * validation the composer chip applies; delete confirms first and always uses
 * the safe `-d` form (git refuses unmerged). Presentational: every action
 * arrives as a callback; the menu/dialog state is local and resets when the
 * branch list identity changes.
 *
 * @module git-worktree/client/panel/BranchSection
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BranchRow } from '../git-panel-data.ts'
import { branchNameIssue } from '../../normalize.ts'
import { groupRemotes } from '../git-panel-data.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import css from '../GitHistoryPanel.module.css'

/** One open branch menu: the row it belongs to and its viewport rect. */
interface BranchMenuState {
  branch: BranchRow
  rect: { left: number; top: number }
}

/** One staged dialog. */
interface BranchDialogState {
  kind: 'rename' | 'new' | 'new-from' | 'delete'
  branch?: BranchRow
}

/** Track branch-row clicks on this list; the callback receives the row and
 * its viewport rect so the portal can anchor the menu. */
export interface BranchSectionProps {
  t: GitPanelTranslator
  locals: readonly BranchRow[]
  remotes: readonly BranchRow[]
  /** A branch mutation (checkout/rename/delete/create) is in flight. */
  busy: boolean
  onCheckout: (branch: BranchRow) => void
  onRename: (branch: BranchRow, newName: string) => void
  onDelete: (branch: BranchRow) => void
  onCreate: (name: string, from?: string) => void
  /** Localized title of the delete confirm's target (the shared ask line). */
}

/** The action menu as a body portal, fixed-positioned next to the row. */
function BranchFloatMenu(props: {
  state: BranchMenuState
  t: GitPanelTranslator
  busy: boolean
  onAction: (action: 'checkout' | 'new-from' | 'rename' | 'delete' | 'copy') => void
  onClose: () => void
}): JSX.Element | null {
  const { state, t, busy, onAction, onClose } = props
  const { branch } = state
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
    // Keep the menu inside the viewport: flip above the row when it would
    // overflow the bottom, clamp the left edge.
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(state.rect.left, window.innerWidth - rect.width - 8))
    let top = state.rect.top
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, state.rect.top - rect.height - 8)
    el.style.left = `${String(Math.round(left))}px`
    el.style.top = `${String(Math.round(top))}px`
  }, [state])

  return createPortal(
    <div ref={ref} className={`${css.menu} ${css.floatMenu}`} role="menu">
      <div className={css.menuHead}>
        {t('panel.branches')} · <span className={css.menuHeadStrong}>{branch.name}</span>
        {branch.current ? ` · ${t('panel.branchCurrent')}` : ''}
      </div>
      {!branch.current ? (
        <button type="button" role="menuitem" className={css.menuItem} disabled={busy} onClick={() => onAction('checkout')}>
          {branch.kind === 'remote' ? t('panel.branchCheckoutRemote') : t('panel.branchCheckout')}
        </button>
      ) : null}
      <button type="button" role="menuitem" className={css.menuItem} disabled={busy} onClick={() => onAction('new-from')}>
        {t('panel.branchNewFrom')}
      </button>
      {branch.kind === 'local' ? (
        <button type="button" role="menuitem" className={css.menuItem} disabled={busy} onClick={() => onAction('rename')}>
          {t('panel.branchRename')}
        </button>
      ) : null}
      {branch.kind === 'local' && !branch.current ? (
        <button type="button" role="menuitem" className={`${css.menuItem} ${css.menuDanger}`} disabled={busy} onClick={() => onAction('delete')}>
          {t('panel.branchDelete')}
        </button>
      ) : null}
      <button type="button" role="menuitem" className={css.menuItem} disabled={busy} onClick={() => onAction('copy')}>
        {t('panel.branchCopy')}
      </button>
    </div>,
    document.body,
  )
}

/** The branches section. */
export function BranchSection(props: BranchSectionProps): JSX.Element {
  const { t, locals, remotes, busy, onCheckout, onRename, onDelete, onCreate } = props
  const [menu, setMenu] = useState<BranchMenuState | null>(null)
  const [dialog, setDialog] = useState<BranchDialogState | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())

  const toggleGroup = (key: string): void => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const total = locals.length + remotes.length

  const openMenu = (branch: BranchRow, event: ReactMouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ branch, rect: { left: rect.left, top: rect.bottom + 5 } })
  }

  const openDialog = (kind: BranchDialogState['kind'], branch?: BranchRow): void => {
    setMenu(null)
    setDraft(kind === 'rename' ? branch?.name ?? '' : '')
    setDialog({ kind, ...(branch === undefined ? {} : { branch }) })
  }

  const menuAction = (action: 'checkout' | 'new-from' | 'rename' | 'delete' | 'copy'): void => {
    const state = menu
    if (state === null) return
    if (action === 'checkout') {
      setMenu(null)
      onCheckout(state.branch)
      return
    }
    if (action === 'copy') {
      setMenu(null)
      void navigator.clipboard.writeText(state.branch.name).catch(() => { /* clipboard unavailable: nothing to recover */ })
      return
    }
    openDialog(action, state.branch)
  }

  const draftIssue = dialog !== null && dialog.kind !== 'delete' ? branchNameIssue(draft) : undefined
  const duplicateIssue = dialog !== null && dialog.kind !== 'delete' && draftIssue === undefined
    && [...locals, ...remotes].some(row => row.kind === 'local' && row.name === draft)
      ? t('menuNewBranchExists')
      : undefined
  const inputError = draftIssue ?? duplicateIssue

  const submitDialog = (): void => {
    if (dialog === null || busy) return
    if (dialog.kind === 'delete') {
      if (dialog.branch !== undefined) onDelete(dialog.branch)
      setDialog(null)
      return
    }
    if (draft === '' || inputError !== undefined) return
    if (dialog.kind === 'rename' && dialog.branch !== undefined) {
      onRename(dialog.branch, draft)
    } else if (dialog.kind === 'new') {
      onCreate(draft)
    } else if (dialog.kind === 'new-from' && dialog.branch !== undefined) {
      onCreate(draft, dialog.branch.name)
    }
    setDialog(null)
  }

  const dialogTitle = dialog === null ? ''
    : dialog.kind === 'rename' && dialog.branch !== undefined
      ? t('renameBranchTitle', { branch: dialog.branch.name })
      : dialog.kind === 'new-from' && dialog.branch !== undefined
        ? t('createFlyAskFrom', { branch: dialog.branch.name })
        : t('createFlyAsk')

  // Two IDEA-style trees: 本地 → branches, 远程 → per-remote → branches.
  // Group headers toggle collapse; rows open the action menu on click.
  const groupHead = (key: string, label: string, count: number, nested: boolean): JSX.Element => (
    <div
      className={`${css.treeHead} ${nested ? css.treeHeadNest : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsedGroups.has(key)}
      onClick={() => toggleGroup(key)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggleGroup(key)
        }
      }}
    >
      <span className={css.treeChevron}>
        {collapsedGroups.has(key)
          ? <IconChevronRightOutlineRegular size={12} />
          : <IconChevronDownOutlineRegular size={12} />}
      </span>
      <span>{label}</span>
      <span className={css.countBadge}>{String(count)}</span>
    </div>
  )

  const renderBranchRow = (row: BranchRow, displayName?: string): JSX.Element => (
    <div
      key={row.name}
      className={`${css.branchRow} ${row.current ? css.branchRowCurrent : ''}`}
      role="button"
      tabIndex={0}
      onClick={event => openMenu(row, event)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openMenu(row, event as unknown as ReactMouseEvent<HTMLDivElement>)
        }
      }}
    >
      <span className={css.branchMark}>
        {row.current ? <IconCheckOutlineRegular size={13} /> : '⎇'}
      </span>
      <span className={css.branchName} title={row.name}>
        {displayName ?? row.name}
      </span>
      <span className={css.branchTrack}>
        {row.ahead !== undefined || row.behind !== undefined
          ? `↓${String(row.behind ?? 0)} ↑${String(row.ahead ?? 0)}`
          : ''}
      </span>
    </div>
  )

  return (
    <section className={css.section} aria-label={t('panel.branches')}>
      <div className={css.sectionHead}>
        <h2 className={css.sectionTitle}>{t('panel.branches')}</h2>
        <div className={css.sectionTools}>
          <button type="button" className={css.act} disabled={busy} onClick={() => openDialog('new')}>
            + {t('panel.branchNew')}
          </button>
        </div>
      </div>
      <div className={css.sectionBody}>
        {total === 0 ? <p className={css.empty}>{t('menuNoBranches')}</p> : null}
        {locals.length > 0 ? (
          <div>
            {groupHead('local', t('panel.branchLocals'), locals.length, false)}
            {!collapsedGroups.has('local') ? (
              <div className={css.treeChildren}>
                {locals.map(row => renderBranchRow(row))}
              </div>
            ) : null}
          </div>
        ) : null}
        {remotes.length > 0 ? (
          <div>
            {groupHead('remote', t('panel.branchRemotes'), remotes.length, false)}
            {!collapsedGroups.has('remote') ? (
              <div className={css.treeNest}>
                {groupRemotes(remotes).map(group => (
                  <div key={group.remote}>
                    {groupHead(`remote:${group.remote}`, group.remote, group.branches.length, true)}
                    {!collapsedGroups.has(`remote:${group.remote}`) ? (
                      <div className={css.treeChildren}>
                        {group.branches.map(row => renderBranchRow(row, row.short))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {menu !== null ? (
        <BranchFloatMenu state={menu} t={t} busy={busy} onAction={menuAction} onClose={() => setMenu(null)} />
      ) : null}
      <Modal
        open={dialog !== null && dialog.kind !== 'delete'}
        onClose={() => setDialog(null)}
        title={dialogTitle}
        closeLabel={t('close')}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy || draft === '' || inputError !== undefined} onClick={submitDialog}>
              {t('actionConfirm')}
            </Button>
          </>
        }
      >
        <div className={css.formField}>
          <label className={css.formLabel} htmlFor="git-panel-branch-name">{t('menuNewBranchPlaceholder')}</label>
          <input
            id="git-panel-branch-name"
            className={css.formInput}
            value={draft}
            data-modal-autofocus
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submitDialog() }}
          />
          <div className={css.formError}>{inputError ?? ''}</div>
        </div>
      </Modal>
      <Modal
        open={dialog !== null && dialog.kind === 'delete' && dialog.branch !== undefined}
        onClose={() => setDialog(null)}
        title={t('ctxDelete')}
        closeLabel={t('close')}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={submitDialog}>{t('actionConfirm')}</Button>
          </>
        }
      >
        <p className={css.formLabel}>
          {dialog?.branch !== undefined ? t('deleteBranchAsk', { branch: dialog.branch.name }) : ''}
        </p>
      </Modal>
    </section>
  )
}
