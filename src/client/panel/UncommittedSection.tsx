/**
 * UncommittedSection: the panel's first block — the staged/unstaged file
 * groups, the commit box, and the sync tools. Presentational only: the rows,
 * the draft, and every action arrive as props from the panel state owner, so
 * this file renders and never talks to git itself.
 *
 * The commit affordance is a split button: the main face commits, the caret
 * opens the two op variants (commit; commit and push). The AI button fills
 * the draft from the host's one-shot llm route — it renders only when the
 * panel knows the session's model selection.
 *
 * @module git-worktree/client/panel/UncommittedSection
 */

import { useEffect, useRef } from 'react'
import { IconDownloadOutlineMedium, IconPaperPlaneOutlineMedium, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChangeRow } from '../git-panel-data.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import { COMMIT_MESSAGE_LIMIT } from '../../wire.ts'
import css from '../GitHistoryPanel.module.css'

/** Status letter → its localized title. */
function statusTitle(status: ChangeRow['status'], t: GitPanelTranslator): string {
  if (status === '?') return t('panel.stUntrack')
  if (status === 'U') return t('panel.stUnmerged')
  if (status === 'A') return t('panel.stAdd')
  if (status === 'D') return t('panel.stDel')
  if (status === 'R') return t('panel.stRen')
  if (status === 'C') return t('panel.stCopy')
  if (status === 'T') return t('panel.stType')
  return t('panel.stMod')
}

/** One file row: checkbox = stage/unstage the path. */
function ChangeRowView(props: {
  row: ChangeRow
  disabled: boolean
  onToggle: (row: ChangeRow) => void
  t: GitPanelTranslator
}): JSX.Element {
  const { row, disabled, onToggle, t } = props
  return (
    <label className={css.changeRow}>
      <input
        type="checkbox"
        className={css.changeCheck}
        checked={row.staged}
        disabled={disabled}
        onChange={() => onToggle(row)}
      />
      <span
        className={`${css.statusBadge} ${css[`status${row.status === '?' ? 'Q' : row.status}`]}`}
        title={statusTitle(row.status, t)}
      >
        {row.status === '?' ? '?' : row.status}
      </span>
      <span className={css.changePath} title={row.oldPath === undefined ? row.path : `${row.oldPath} → ${row.path}`}>
        {row.oldPath === undefined ? row.path : `${row.oldPath} → ${row.path}`}
      </span>
      <span className={css.stageHint}>{row.staged ? t('panel.unstageHint') : t('panel.stageHint')}</span>
    </label>
  )
}

/** All props are owned by GitHistoryPanel; this component renders them. */
export interface UncommittedSectionProps {
  t: GitPanelTranslator
  staged: readonly ChangeRow[]
  unstaged: readonly ChangeRow[]
  /** A section mutation (stage/unstage/commit/AI) is in flight. */
  busy: boolean
  /** The sync tools (fetch/update/push) are in flight. */
  syncBusy: boolean
  /** The server cut the change list to its cap (a busier tree exists). */
  truncated: boolean
  commitDraft: string
  onCommitDraft: (text: string) => void
  commitMenuOpen: boolean
  onToggleCommitMenu: () => void
  onCommit: (push: boolean) => void
  onToggleRow: (row: ChangeRow) => void
  onStageAll: () => void
  onUnstageAll: () => void
  aiAvailable: boolean
  aiBusy: boolean
  onAiGenerate: () => void
  onFetch: () => void
  onUpdate: () => void
  onPush: () => void
}

/** The uncommitted-changes section body. */
export function UncommittedSection(props: UncommittedSectionProps): JSX.Element {
  const {
    t, staged, unstaged, busy, syncBusy, truncated, commitDraft, onCommitDraft, commitMenuOpen, onToggleCommitMenu,
    onCommit, onToggleRow, onStageAll, onUnstageAll, aiAvailable, aiBusy, onAiGenerate, onFetch, onUpdate, onPush,
  } = props
  const menuRef = useRef<HTMLDivElement | null>(null)

  // An outside pointerdown dismisses the commit-op menu — the same dismissal
  // discipline the branch menu applies, local to this block.
  useEffect(() => {
    if (!commitMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) onToggleCommitMenu()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onToggleCommitMenu()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [commitMenuOpen, onToggleCommitMenu])

  const total = staged.length + unstaged.length
  const canCommit = staged.length > 0 && commitDraft.trim() !== ''
  const hint = staged.length === 0
    ? t('panel.commitNeedsStaged')
    : commitDraft.trim() === '' ? t('panel.commitNeedsMessage') : ''
  // The generator diffs the working tree: with no changes at all there is
  // nothing to describe, so the button idles instead of round-tripping a 400.
  const aiReady = aiAvailable && total > 0

  return (
    <section className={css.section} aria-label={t('panel.uncommitted')}>
      <div className={css.sectionHead}>
        <h2 className={css.sectionTitle}>{t('panel.uncommitted')}</h2>
        {total > 0 ? <span className={css.countBadge}>{String(total)}</span> : null}
        <div className={css.sectionTools}>
          <button type="button" className={css.act} disabled={syncBusy} onClick={onFetch} title={t('menuFetch')}>
            <IconDownloadOutlineMedium size={13} />
            {t('menuFetch')}
          </button>
          <button type="button" className={css.act} disabled={syncBusy} onClick={onUpdate} title={t('menuUpdate')}>
            <IconDownloadOutlineMedium size={13} />
            {t('menuUpdate')}
          </button>
          <button type="button" className={css.act} disabled={syncBusy} onClick={onPush} title={t('menuPush')}>
            <IconPaperPlaneOutlineMedium size={13} />
            {t('menuPush')}
          </button>
        </div>
      </div>
      <div className={css.sectionBody}>
        {total === 0 ? <p className={css.empty}>{t('panel.clean')}</p> : null}
        {truncated ? <p className={css.empty}>{t('panel.changesTruncated')}</p> : null}
        {staged.length > 0 ? (
          <div>
            <div className={css.groupTitleRow}>
              {t('panel.staged')}
              <span className={css.countBadge}>{String(staged.length)}</span>
              <button type="button" className={css.linkBtn} disabled={busy} onClick={onUnstageAll}>{t('panel.unstageAll')}</button>
            </div>
            {staged.map(row => (
              <ChangeRowView key={`${row.staged}:${row.path}:${row.oldPath ?? ''}`} row={row} disabled={busy} onToggle={onToggleRow} t={t} />
            ))}
          </div>
        ) : null}
        {unstaged.length > 0 ? (
          <div>
            <div className={css.groupTitleRow}>
              {t('panel.unstaged')}
              <span className={css.countBadge}>{String(unstaged.length)}</span>
              <button type="button" className={css.linkBtn} disabled={busy} onClick={onStageAll}>{t('panel.stageAll')}</button>
            </div>
            {unstaged.map(row => (
              <ChangeRowView key={`u:${row.path}:${row.oldPath ?? ''}`} row={row} disabled={busy} onToggle={onToggleRow} t={t} />
            ))}
          </div>
        ) : null}
        <div className={css.commitBox}>
          <textarea
            className={css.commitInput}
            value={commitDraft}
            placeholder={t('panel.commitPlaceholder')}
            aria-label={t('panel.commitPlaceholder')}
            rows={2}
            maxLength={COMMIT_MESSAGE_LIMIT}
            onChange={event => onCommitDraft(event.target.value)}
          />
          <div className={css.commitActions}>
            {aiAvailable ? (
              <button
                type="button"
                className={css.act}
                disabled={busy || aiBusy || !aiReady}
                title={!aiReady ? t('panel.aiNeedsChanges') : undefined}
                onClick={onAiGenerate}
              >
                <IconSparkleRegular size={13} />
                {aiBusy ? t('panel.aiBusy') : t('panel.aiGenerate')}
              </button>
            ) : null}
            <div className={css.split} ref={menuRef}>
              <button
                type="button"
                className={`${css.act} ${css.actPrimary} ${css.splitMain}`}
                disabled={!canCommit || busy}
                onClick={() => onCommit(false)}
              >
                {busy ? t('panel.commitBusy') : t('panel.commit')}
              </button>
              <button
                type="button"
                className={`${css.act} ${css.actPrimary} ${css.splitCaret}`}
                aria-label={t('panel.commitMoreAria')}
                aria-expanded={commitMenuOpen}
                disabled={busy}
                onClick={onToggleCommitMenu}
              >
                ▾
              </button>
              {commitMenuOpen ? (
                <div className={css.menu} role="menu">
                  <button type="button" role="menuitem" className={css.menuItem} disabled={!canCommit} onClick={() => onCommit(false)}>
                    {t('panel.commit')}
                  </button>
                  <button type="button" role="menuitem" className={css.menuItem} disabled={!canCommit} onClick={() => onCommit(true)}>
                    {t('panel.commitPush')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className={css.commitHint}>{hint}</div>
        </div>
      </div>
    </section>
  )
}
