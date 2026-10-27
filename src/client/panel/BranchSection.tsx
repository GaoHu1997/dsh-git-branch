/**
 * BranchSection: the panel's middle block — the branch list with an IDEA-style
 * action menu. RIGHT-CLICKING any row opens a small menu anchored to it
 * (checkout, new branch from here, rename, delete, copy name — remote rows
 * narrow it to the actions a remote branch can take); the CURRENT branch's
 * menu hides only checkout and delete, so rename/new-from/copy stay
 * reachable. Keyboard rows keep Enter/Space as the menu opener — a context
 * menu has no keyboard twin. Rename and create run through the Modal
 * primitive with the same client-side name validation the composer chip
 * applies; delete confirms first and always uses the safe `-d` form (git
 * refuses unmerged). Presentational: every action arrives as a callback; the
 * menu/dialog state is local and resets when the branch list identity
 * changes.
 *
 * The tree opens on 本地 only (the current branch lives there) and the card
 * takes one share of the panel's fixed 2:1:2 split (its body scrolls inside
 * it), so a branch-heavy repository can no longer push the other cards off
 * screen. 全部展开/全部折叠 drive every group at once, and after a checkout
 * (or expand-all) the card re-centers on the current branch row.
 *
 * The head carries a search box: it filters both trees by branch name
 * (case-insensitive substring), and while a query is active every matching
 * group renders expanded with its count following the filter — the folded
 * state the user set is untouched and comes back when the query clears.
 *
 * @module git-worktree/client/panel/BranchSection
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BranchRow } from '../git-panel-data.ts'
import { branchNameIssue } from '../../normalize.ts'
import { branchGroupKeys, filterBranches, groupRemotes } from '../git-panel-data.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import { FloatMenu } from './FloatMenu.tsx'
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

/** Groups folded when the card mounts: the remote tree only. The current
 * branch lives at the TOP of the local group (buildBranchRows sorts it
 * first), so 本地 stays open — the card opens showing what the panel is
 * about, without the wall of remote branches. */
const COLLAPSED_ON_MOUNT: ReadonlySet<string> = new Set(['remote'])

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

  return (
    <FloatMenu anchor={state.rect} onClose={onClose}>
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
    </FloatMenu>
  )
}

/** The branches section. */
export function BranchSection(props: BranchSectionProps): JSX.Element {
  const { t, locals, remotes, busy, onCheckout, onRename, onDelete, onCreate } = props
  const [menu, setMenu] = useState<BranchMenuState | null>(null)
  const [dialog, setDialog] = useState<BranchDialogState | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(COLLAPSED_ON_MOUNT)

  /** The card's scroll body — the locate math centers rows inside it. */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** The current branch this mount last centered on. A refresh re-centers
   * only when the checkout moved; a same-branch refresh (stage, commit…)
   * keeps the scroll where the user left it. */
  const locatedRef = useRef<string | null>(null)
  /** Expand-all asks for one more locate — its rows mount on the next commit. */
  const pendingLocateRef = useRef(false)

  const toggleGroup = (key: string): void => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = (): void => {
    pendingLocateRef.current = true
    setCollapsedGroups(new Set())
  }

  const collapseAll = (): void => {
    setCollapsedGroups(new Set(branchGroupKeys(remotes)))
  }

  /** Center the current branch row in the card body (no scroll when the
   * body is shorter than its cap). Rect arithmetic, not offsetTop: no
   * positioned ancestor is guaranteed between the row and the body. */
  const locateCurrent = (): void => {
    const body = bodyRef.current
    if (body === null) return
    const row = body.querySelector('[data-current="true"]')
    if (!(row instanceof HTMLElement)) return
    const top = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
    body.scrollTop = Math.max(0, top - (body.clientHeight - row.offsetHeight) / 2)
  }

  // After every commit (no dep array — expand-all and checkouts land through
  // different states): center the card on the current branch when the
  // checkout moved or expand-all explicitly asked, and only when the row is
  // actually rendered (its group open).
  useLayoutEffect(() => {
    const current = locals.find(row => row.current)?.name
    if (current === undefined) return
    if (!pendingLocateRef.current && current === locatedRef.current) return
    pendingLocateRef.current = false
    locatedRef.current = current
    locateCurrent()
  })

  const total = locals.length + remotes.length

  /** The head search: name-substring rows only. A live query opens every
   * group whatever the folded state is (a hidden match reads as a bug),
   * without touching that state — clearing the query restores it. */
  const searching = query.trim() !== ''
  const visibleLocals = filterBranches(locals, query)
  const visibleRemotes = filterBranches(remotes, query)
  const openGroup = (key: string): boolean => searching || !collapsedGroups.has(key)
  const matched = visibleLocals.length + visibleRemotes.length

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
  // Group headers toggle collapse; rows open the action menu on right-click.
  const groupHead = (key: string, label: string, count: number, nested: boolean): JSX.Element => (
    <div
      className={`${css.treeHead} ${nested ? css.treeHeadNest : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={openGroup(key)}
      onClick={() => toggleGroup(key)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggleGroup(key)
        }
      }}
    >
      <span className={css.treeChevron}>
        {openGroup(key)
          ? <IconChevronDownOutlineRegular size={12} />
          : <IconChevronRightOutlineRegular size={12} />}
      </span>
      <span>{label}</span>
      <span className={css.countBadge}>{String(count)}</span>
    </div>
  )

  const renderBranchRow = (row: BranchRow, displayName?: string): JSX.Element => (
    <div
      key={row.name}
      className={`${css.branchRow} ${row.current ? css.branchRowCurrent : ''}`}
      data-current={row.current ? 'true' : undefined}
      role="button"
      tabIndex={0}
      onContextMenu={event => {
        // IDEA posture: the action menu is a context menu — suppress the
        // browser's own and anchor ours to the row.
        event.preventDefault()
        openMenu(row, event)
      }}
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
    <section className={`${css.section} ${css.sectionFill} ${css.sectionBranches}`} aria-label={t('panel.branches')}>
      <div className={css.sectionHead}>
        <h2 className={css.sectionTitle}>{t('panel.branches')}</h2>
        <div className={`${css.searchBox} ${css.searchBoxHead}`}>
          <span aria-hidden="true">⌕</span>
          <input
            type="text"
            className={css.searchInput}
            value={query}
            placeholder={t('menuSearchPlaceholder')}
            aria-label={t('menuSearchPlaceholder')}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <div className={css.sectionTools}>
          <button type="button" className={css.treeToggle} onClick={expandAll}>{t('menuExpandAll')}</button>
          <button type="button" className={css.treeToggle} onClick={collapseAll}>{t('menuCollapseAll')}</button>
          <button type="button" className={css.act} disabled={busy} onClick={() => openDialog('new')}>
            + {t('panel.branchNew')}
          </button>
        </div>
      </div>
      <div className={`${css.sectionBody} ${css.sectionBodyScroll}`} ref={bodyRef}>
        {total === 0 ? <p className={css.empty}>{t('menuNoBranches')}</p> : null}
        {total > 0 && matched === 0 ? <p className={css.empty}>{t('menuNoMatches')}</p> : null}
        {visibleLocals.length > 0 ? (
          <div>
            {groupHead('local', t('panel.branchLocals'), visibleLocals.length, false)}
            {openGroup('local') ? (
              <div className={css.treeChildren}>
                {visibleLocals.map(row => renderBranchRow(row))}
              </div>
            ) : null}
          </div>
        ) : null}
        {visibleRemotes.length > 0 ? (
          <div>
            {groupHead('remote', t('panel.branchRemotes'), visibleRemotes.length, false)}
            {openGroup('remote') ? (
              <div className={css.treeNest}>
                {groupRemotes(visibleRemotes).map(group => (
                  <div key={group.remote}>
                    {groupHead(`remote:${group.remote}`, group.remote, group.branches.length, true)}
                    {openGroup(`remote:${group.remote}`) ? (
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
