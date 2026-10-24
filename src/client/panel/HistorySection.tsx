/**
 * HistorySection: the panel's third block — the commit list. One row shows
 * the subject, its refs badges, the author and the relative time, and the
 * file count with the short hash; hovering a row raises the framework
 * Tooltip (subject · author <email> · absolute time · hash); CLICKING a row
 * expands the commit's changed files INLINE below it (exactly one open at a
 * time), loading them on first open. The search input filters the loaded
 * page client-side; "load more" fetches the next page.
 *
 * @module git-worktree/client/panel/HistorySection
 */

import { forwardRef, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, Ref } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommitEntry, CommitFileEntry } from '../../wire.ts'
import { classifyRefs, filterCommits } from '../git-panel-data.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
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
  first: boolean
  last: boolean
  open: boolean
  files: CommitFilesState | undefined
  t: GitPanelTranslator
  onToggle: (hash: string) => void
  timeLabelFor: (date: number) => string
}

/** One history row; `ref` and the tooltip's hover handlers arrive through
 * the anchor share when the row is wrapped in a Tooltip. */
const CommitRow = forwardRef<HTMLDivElement, CommitRowProps>(function CommitRow(props, ref) {
  const { commit, first, last, open, files, t, onToggle, timeLabelFor } = props
  const badges = classifyRefs(commit.refs)
  const when = new Date(commit.date)
  const absolute = Number.isFinite(commit.date) && commit.date > 0
    ? `${when.toLocaleDateString()} ${when.toLocaleTimeString()}`
    : ''
  const authorInitial = commit.authorName.slice(0, 1)
  return (
    <div
      ref={ref}
      className={[
        css.commitRow,
        first ? css.commitRowFirst : '',
        last ? css.commitRowLast : '',
        open ? css.commitRowOpen : '',
      ].filter(name => name !== '').join(' ')}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-describedby={props['aria-describedby']}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onClick={() => onToggle(commit.hash)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(commit.hash) } }}
    >
      <div className={css.commitGraph}>
        <span className={`${css.commitDot} ${commit.parents.length > 1 ? css.commitDotMerge : ''}`} />
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
          <span className={css.authorDot} aria-hidden="true">{authorInitial}</span>
          <span>{commit.authorName}</span>
          <span>{timeLabelFor(commit.date)}</span>
        </div>
      </div>
      <div className={css.commitSide}>
        <span className={css.commitHash}>{commit.short}</span>
      </div>
      {open ? (
        <div className={css.commitExpand}>
          <div className={css.commitExpandTitle}>
            {t('panel.filesTitle', { n: files?.kind === 'loaded' ? files.files.length : 0, author: commit.authorName, date: absolute })}
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
  onLoadMore: () => void
  onToggle: (hash: string) => void
  timeLabelFor: (date: number) => string
}

export function HistorySection(props: HistorySectionProps): JSX.Element {
  const { t, commits, loaded, loadError, loading, hasMore, loadingMore, expanded, filesByHash, onLoadMore, onToggle, timeLabelFor } = props
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = filterCommits(commits, query)

  return (
    <section className={`${css.section} ${css.sectionFill} ${css.sectionHistory}`} aria-label={t('panel.history')}>
      <div className={css.historyHead}>
        <h2 className={css.sectionTitle}>{t('panel.history')}</h2>
        <div className={css.searchBox}>
          <span aria-hidden="true">⌕</span>
          <input
            type="text"
            className={css.searchInput}
            value={query}
            placeholder={t('panel.historySearch')}
            aria-label={t('panel.historySearch')}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
      </div>
      <div className={`${css.sectionBody} ${css.sectionBodyScroll}`}>
        {loadError !== undefined ? <div className={css.errorText}>{loadError}</div>
          : !loaded && loading ? <div className={css.empty}>{t('manager.loading')}</div>
            : visible.length === 0 ? <div className={css.empty}>{needle === '' ? t('panel.noCommits') : t('panel.noMatches')}</div>
              : visible.map((commit, index) => (
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
                    first={index === 0}
                    last={index === visible.length - 1}
                    open={expanded === commit.hash}
                    files={filesByHash[commit.hash]}
                    t={t}
                    onToggle={onToggle}
                    timeLabelFor={timeLabelFor}
                  />
                </Tooltip>
              ))}
        {hasMore && visible.length === commits.length ? (
          <div className={css.moreRow}>
            <button type="button" className={css.act} disabled={loadingMore} onClick={onLoadMore}>
              {t('panel.loadMore')}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
