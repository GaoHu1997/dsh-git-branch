/**
 * HistorySection: the panel's third block — the commit graph. Every row
 * draws its lane picture (vertical rails, curved merges, hollow dots for
 * merge commits) from `buildGraph`, then the subject, its refs badges, the
 * author, and the absolute commit time. CLICKING a row expands the commit's
 * changed files INLINE below it (exactly one open at a time), loading them on
 * first open; RIGHT-CLICKING it opens the commit menu (copy hash, copy
 * subject, new branch here, tag here), which is where the history card's two
 * writing verbs live.
 *
 * The head carries the three filters the card asks for, in this order —
 * author, branch (a ref to pin the walk on, or every ref), and a time window
 * (all / last 24h / last 7 days / a custom day range). They are NOT applied
 * here: this section is presentational, so it hands each change up and the
 * data owner refetches.
 * Filtering client-side would have been wrong for a paged list — the page
 * holds 50 commits, and a needle outside it would silently report "no match".
 *
 * @module git-worktree/client/panel/HistorySection
 */

import { forwardRef, useMemo, useState } from 'react'
import type { CSSProperties, FocusEventHandler, MouseEventHandler, Ref } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommitEntry, CommitFileEntry } from '../../wire.ts'
import { branchNameIssue } from '../../normalize.ts'
import { buildGraph, graphWidth } from '../git-graph.ts'
import type { GraphRow } from '../git-graph.ts'
import { classifyRefs } from '../git-panel-data.ts'
import type { HistoryFilters, HistoryRange } from '../git-panel-data.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import { CommitGraph, CommitGraphContinuation, LANE_PITCH } from './CommitGraph.tsx'
import { FloatMenu } from './FloatMenu.tsx'
import css from '../GitHistoryPanel.module.css'

/** Anchor share the Tooltip primitive injects into its single child (mirror
 * of the primitives' AnchorProps, which is not exported). */
interface TooltipAnchorProps {
  readonly ref?: Ref<HTMLDivElement>
  readonly onMouseEnter?: MouseEventHandler<HTMLDivElement>
  readonly onMouseLeave?: MouseEventHandler<HTMLDivElement>
  readonly onFocus?: FocusEventHandler<HTMLDivElement>
  readonly onBlur?: FocusEventHandler<HTMLDivElement>
  readonly 'aria-describedby'?: string | undefined
}

/** How one expanded commit's files stand. */
export type CommitFilesState =
  | { readonly kind: 'loaded'; readonly files: readonly CommitFileEntry[] }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }

/** One open commit menu: the commit it belongs to and where it was clicked. */
interface CommitMenuState {
  readonly commit: CommitEntry
  readonly rect: { readonly left: number; readonly top: number }
}

/** One open commit dialog: which verb, and on which commit. */
interface CommitDialogState {
  readonly kind: 'branch' | 'tag'
  readonly commit: CommitEntry
}

/** `YYYY/MM/DD HH:mm` in the browser's zone — the reference screenshot's
 * right-hand time column. Field-by-field on purpose: `toLocaleString` varies
 * with the user's locale and would break the column's alignment. */
function formatStamp(date: number): string {
  if (!Number.isFinite(date) || date <= 0) return ''
  const at = new Date(date)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}/${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function statusTitle(status: CommitFileEntry['status'], t: GitPanelTranslator): string {
  if (status === 'A') return t('panel.stAdd')
  if (status === 'D') return t('panel.stDel')
  if (status === 'R') return t('panel.stRen')
  if (status === 'C') return t('panel.stCopy')
  if (status === 'T') return t('panel.stType')
  return t('panel.stMod')
}

function FileRow(props: { file: CommitFileEntry; t: GitPanelTranslator }): JSX.Element {
  const { file, t } = props
  return (
    <div className={css.fileRow}>
      <span
        className={`${css.statusBadge} ${css[`status${file.status}`]}`}
        title={statusTitle(file.status, t)}
      >
        {file.status}
      </span>
      <span
        className={css.filePath}
        title={file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
      >
        {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
      </span>
      <span className={css.fileNums}>
        {file.binary === true
          ? t('panel.binary')
          : file.insertions !== undefined || file.deletions !== undefined
            ? (
              <>
                <b className={css.fileAdd}>{`+${String(file.insertions ?? 0)}`}</b>
                {' '}
                <b className={css.fileDel}>{`-${String(file.deletions ?? 0)}`}</b>
              </>
            )
            : ''}
      </span>
    </div>
  )
}

interface CommitRowProps extends TooltipAnchorProps {
  commit: CommitEntry
  graph: GraphRow
  graphWidth: number
  open: boolean
  files: CommitFilesState | undefined
  t: GitPanelTranslator
  onToggle: (hash: string) => void
  onMenu: (commit: CommitEntry, rect: { left: number; top: number }) => void
}

/** One history row; `ref` and the tooltip's hover handlers arrive through
 * the anchor share when the row is wrapped in a Tooltip. */
const CommitRow = forwardRef<HTMLDivElement, CommitRowProps>(function CommitRow(props, ref) {
  const { commit, graph, graphWidth, open, files, t, onToggle, onMenu } = props
  const badges = classifyRefs(commit.refs)
  const stamp = formatStamp(commit.date)
  return (
    <div
      ref={ref}
      className={[css.commitRow, open ? css.commitRowOpen : ''].filter(name => name !== '').join(' ')}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-describedby={props['aria-describedby']}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onClick={() => onToggle(commit.hash)}
      onContextMenu={event => {
        event.preventDefault()
        onMenu(commit, { left: event.clientX, top: event.clientY })
      }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(commit.hash) } }}
    >
      <div className={css.commitGraph}>
        <CommitGraph row={graph} width={graphWidth} merge={commit.parents.length > 1} />
      </div>
      <div className={css.commitMain}>
        <div className={css.commitSubject}>
          <span className={css.commitSubjectText}>{commit.subject}</span>
          <span className={css.refBadges}>
            {badges.map(badge => (
              <span key={`${badge.kind}:${badge.text}`} className={`${css.refBadge} ${css[`ref${badge.kind[0]?.toUpperCase() ?? ''}${badge.kind.slice(1)}`]}`}>
                {badge.text}
              </span>
            ))}
          </span>
        </div>
        <div className={css.commitMeta}>
          <span className={css.commitAuthor}>{commit.authorName}</span>
        </div>
      </div>
      <div className={css.commitSide}>
        <span className={css.commitDate} title={stamp}>{stamp}</span>
      </div>
      {open ? (
        <div className={css.commitExpand}>
          <CommitGraphContinuation row={graph} width={graphWidth} />
          <div className={css.commitExpandTitle}>
            {t('panel.filesTitle', { n: files?.kind === 'loaded' ? files.files.length : 0, author: commit.authorName, date: stamp })}
          </div>
          {files === undefined || files.kind === 'loading' ? (
            <div className={css.commitExpandTitle}>{t('manager.loading')}</div>
          ) : files.kind === 'failed' ? (
            <div className={css.errorText}>{files.message}</div>
          ) : (
            files.files.map(file => <FileRow key={`${file.status}:${file.path}`} file={file} t={t} />)
          )}
        </div>
      ) : null}
    </div>
  )
})

/** Tooltip label resolver: one line spelling subject, author, time, hash. */
function tooltipLabel(commit: CommitEntry): string {
  const when = new Date(commit.date)
  const absolute = Number.isFinite(commit.date) && commit.date > 0
    ? `${when.toLocaleDateString()} ${when.toLocaleTimeString()}`
    : ''
  return `${commit.subject} · ${commit.authorName} <${commit.authorEmail}> · ${absolute} · ${commit.short}`
}

/** The commit-history section. */
export interface HistorySectionProps {
  t: GitPanelTranslator
  commits: readonly CommitEntry[]
  /** Whether the history endpoint returned at least one page. */
  loaded: boolean
  loadError: string | undefined
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  expanded: string | null
  filesByHash: Readonly<Record<string, CommitFilesState>>
  /** The active filter state (owned by the data layer — it drives the fetch). */
  filters: HistoryFilters
  /** Branch names offered by the branch filter. */
  branches: readonly string[]
  /** A mutation is in flight; the menu's writing verbs wait on it. */
  busy: boolean
  onLoadMore: () => void
  onToggle: (hash: string) => void
  onFilters: (filters: HistoryFilters) => void
  onCreateBranch: (name: string, from: string) => void
  onCreateTag: (name: string, target: string, message: string) => void
  pushToast: (text: string, tone: 'success' | 'error') => void
}

export function HistorySection(props: HistorySectionProps): JSX.Element {
  const {
    t, commits, loaded, loadError, loading, hasMore, loadingMore, expanded, filesByHash,
    filters, branches, busy, onLoadMore, onToggle, onFilters, onCreateBranch, onCreateTag, pushToast,
  } = props
  const [menu, setMenu] = useState<CommitMenuState | null>(null)
  const [dialog, setDialog] = useState<CommitDialogState | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [authorDraft, setAuthorDraft] = useState(filters.author)

  const graph = useMemo(() => buildGraph(commits), [commits])
  const bandWidth = useMemo(() => graphWidth(graph) * LANE_PITCH + 4, [graph])

  const openMenu = (commit: CommitEntry, rect: { left: number; top: number }): void => {
    setMenu({ commit, rect })
  }

  const openDialog = (kind: 'branch' | 'tag', commit: CommitEntry): void => {
    setMenu(null)
    setDraft('')
    setMessage('')
    setDialog({ kind, commit })
  }

  const copy = (text: string): void => {
    setMenu(null)
    void navigator.clipboard.writeText(text).then(
      () => pushToast(t('hover.copied'), 'success'),
      () => pushToast(t('errorGeneric', { message: t('hover.copied') }), 'error'),
    )
  }

  const nameIssue = draft.trim() === '' ? 'empty' : branchNameIssue(draft.trim())
  const duplicateBranch = dialog !== null && dialog.kind === 'branch' && branches.includes(draft.trim())
  const dialogError = nameIssue === 'empty'
    ? t('menuNewBranchPlaceholder')
    : nameIssue !== null
      ? t('menuNewBranchBad')
      : duplicateBranch ? t('menuNewBranchExists') : undefined

  const submitDialog = (): void => {
    if (dialog === null || nameIssue !== null || duplicateBranch) return
    const name = draft.trim()
    if (dialog.kind === 'branch') onCreateBranch(name, dialog.commit.hash)
    else onCreateTag(name, dialog.commit.hash, message.trim())
    setDialog(null)
    setDraft('')
    setMessage('')
  }

  /** Commit a pending author needle — Enter or blur, never per keystroke: the
   * filter is a server-side walk, and one request per character would queue
   * dozens of `git log` runs behind a single word. */
  const commitAuthor = (): void => {
    const author = authorDraft.trim()
    if (author === filters.author) return
    onFilters({ ...filters, author })
  }

  // Filter controls are declared before the row list so the JSX order stays
  // top-down (tests/jsx-order.spec.ts scans for the inverse).
  const filterBar = (
    <div className={css.historyFilters}>
      <input
        type="text"
        className={css.filterInput}
        value={authorDraft}
        placeholder={t('panel.historyAuthor')}
        aria-label={t('panel.historyAuthor')}
        onChange={event => setAuthorDraft(event.target.value)}
        onBlur={commitAuthor}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitAuthor() } }}
      />
      <select
        className={css.filterSelect}
        value={filters.branch}
        aria-label={t('panel.historyBranch')}
        onChange={event => onFilters({ ...filters, branch: event.target.value })}
      >
        <option value="">{t('panel.historyAllRefs')}</option>
        {branches.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <select
        className={css.filterSelect}
        value={filters.range}
        aria-label={t('panel.historyTime')}
        onChange={event => onFilters({ ...filters, range: event.target.value as HistoryRange })}
      >
        <option value="all">{t('panel.rangeAll')}</option>
        <option value="day">{t('panel.rangeDay')}</option>
        <option value="week">{t('panel.rangeWeek')}</option>
        <option value="custom">{t('panel.rangeCustom')}</option>
      </select>
      {filters.range === 'custom' ? (
        <>
          <input
            type="date"
            className={css.filterDate}
            value={filters.customSince}
            aria-label={t('panel.rangeSince')}
            onChange={event => onFilters({ ...filters, customSince: event.target.value })}
          />
          <span className={css.filterDash} aria-hidden="true">–</span>
          <input
            type="date"
            className={css.filterDate}
            value={filters.customUntil}
            aria-label={t('panel.rangeUntil')}
            onChange={event => onFilters({ ...filters, customUntil: event.target.value })}
          />
        </>
      ) : null}
    </div>
  )

  const rows = commits.map((commit, index) => (
    <Tooltip
      key={commit.hash}
      label={() => tooltipLabel(commit)}
      side="bottom"
      portal
      maxWidth={380}
      delayMs={250}
    >
      <CommitRow
        commit={commit}
        graph={graph[index] ?? { lane: 0, lanes: 1, edges: [] }}
        graphWidth={bandWidth}
        open={expanded === commit.hash}
        files={filesByHash[commit.hash]}
        t={t}
        onToggle={onToggle}
        onMenu={openMenu}
      />
    </Tooltip>
  ))

  const dialogTitle = dialog === null
    ? ''
    : dialog.kind === 'branch'
      ? t('createFlyAskFrom', { branch: dialog.commit.short })
      : t('panel.tagTitle')

  return (
    <section className={`${css.section} ${css.sectionFill} ${css.sectionHistory}`} aria-label={t('panel.history')}>
      <div className={css.historyHead}>
        <h2 className={css.sectionTitle}>{t('panel.history')}</h2>
        {filterBar}
      </div>
      <div
        className={`${css.sectionBody} ${css.sectionBodyScroll}`}
        style={{ '--graph-w': `${String(bandWidth)}px` } as CSSProperties}
      >
        {loadError !== undefined ? <div className={css.errorText}>{loadError}</div>
          : !loaded && loading ? <div className={css.empty}>{t('manager.loading')}</div>
            : commits.length === 0 ? <div className={css.empty}>{t('panel.noCommits')}</div>
              : <div className={css.commitList}>{rows}</div>}
        {hasMore ? (
          <div className={css.moreRow}>
            <button type="button" className={css.act} disabled={loadingMore} onClick={onLoadMore}>
              {t('panel.loadMore')}
            </button>
          </div>
        ) : null}
      </div>
      {menu !== null ? (
        <FloatMenu anchor={menu.rect} onClose={() => setMenu(null)}>
          <div className={css.menuHead}>{menu.commit.subject}</div>
          <button type="button" className={css.menuItem} role="menuitem" onClick={() => copy(menu.commit.hash)}>
            {t('panel.commitCopyHash')}
          </button>
          <button type="button" className={css.menuItem} role="menuitem" onClick={() => copy(menu.commit.subject)}>
            {t('panel.commitCopySubject')}
          </button>
          <button type="button" className={css.menuItem} role="menuitem" disabled={busy} onClick={() => openDialog('branch', menu.commit)}>
            {t('panel.branchNewFrom')}
          </button>
          <button type="button" className={css.menuItem} role="menuitem" disabled={busy} onClick={() => openDialog('tag', menu.commit)}>
            {t('panel.branchTag')}
          </button>
        </FloatMenu>
      ) : null}
      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialogTitle}
        closeLabel={t('close')}
        footer={(
          <>
            <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy || nameIssue !== null || duplicateBranch} onClick={submitDialog}>
              {t('actionConfirm')}
            </Button>
          </>
        )}
      >
        <div className={css.formField}>
          <label className={css.formLabel} htmlFor="git-panel-commit-name">
            {dialog !== null && dialog.kind === 'tag' ? t('panel.tagName') : t('panel.branchNew')}
          </label>
          <input
            id="git-panel-commit-name"
            className={css.formInput}
            data-modal-autofocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submitDialog() }}
          />
          <div className={css.formError}>{dialogError ?? ''}</div>
        </div>
        {dialog !== null && dialog.kind === 'tag' ? (
          <div className={css.formField}>
            <label className={css.formLabel} htmlFor="git-panel-tag-message">{t('panel.tagMessage')}</label>
            <input
              id="git-panel-tag-message"
              className={css.formInput}
              value={message}
              onChange={event => setMessage(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') submitDialog() }}
            />
          </div>
        ) : null}
      </Modal>
    </section>
  )
}
