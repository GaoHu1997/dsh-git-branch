/**
 * GitHistoryPanel: the git-management tab for the dsh-better-sidebar right
 * sidebar. The entry card, selection, and presentation are better-sidebar's
 * (registered through `ctx.betterSidebar.registerTab` from index.ts); this
 * file renders the TAB CONTENT: a slim chrome (repo pill, refresh) over the
 * three stacked sections (uncommitted changes, branches, commit history).
 * Session facts ride the tab call's scope (sessionId/cwd) plus the session
 * list store (the model-selection projection feeds the AI message
 * generator). All git calls ride the plugin's own routes through the api
 * module; every failure lands in a toast or an inline error line, never a
 * crash boundary.
 *
 * The state owner is {@link GitHistoryPanelData} below: one component owning
 * the status/changes/log state machine, feeding the three presentational
 * sections, keyed by cwd so a session switch starts every section fresh.
 *
 * @module git-worktree/client/GitHistoryPanel
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { IconRefreshOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommitEntry, CommitFileEntry, RepoStatus, WorktreeChange } from '../wire.ts'
import { fetchStatus, requestAiCommitMessage, requestChanges, requestCommit, requestCommitFiles, requestCreateBranch, requestCreateTag, requestDeleteBranch, requestFetch, requestLog, requestPush, requestPushTag, requestRenameBranch, requestStage, requestSwitch, requestUpdate } from './api.ts'
import { emitGitMutated, onGitMutated } from './git-events.ts'
import { appendPage, buildBranchRows, groupChanges, historyQueryFor, type BranchRow, type ChangeRow, type HistoryFilters } from './git-panel-data.ts'
import { EMPTY_HISTORY_FILTERS } from './git-panel-data.ts'
import type { GitPanelTranslator, PanelHostContext, SessionModelSelection, SidebarTabScope } from './panel-types.ts'
import type { AccelFace } from './accel-form.ts'
import { BranchSection } from './panel/BranchSection.tsx'
import { CnAcceleratePopover } from './panel/CnAcceleratePopover.tsx'
import { CredentialModal } from './panel/CredentialModal.tsx'
import { HistorySection, type CommitFilesState } from './panel/HistorySection.tsx'
import { RemotesModal } from './panel/RemotesModal.tsx'
import { UncommittedSection } from './panel/UncommittedSection.tsx'
import css from './GitHistoryPanel.module.css'

/** Tab content props: what the registration's component call hands over.
 * `accel` is the shared cn-accelerate form (topbar button + popover). */
export type GitPanelTabProps = {
  ctx: PanelHostContext
  scope: SidebarTabScope
  t: GitPanelTranslator
  accel: AccelFace
}

/** One history page. Kept next to the loader: `hasMore` is decided by
 * comparing the returned length against it. */
const HISTORY_PAGE = 50

/** One git failure → its message text (the git stderr rides error.message). */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One queued banner: success toasts render the green check, failures keep
 * the primitive's warning tint (tone omitted). */
interface PanelToast {
  seq: number
  text: string
  tone: 'success' | 'error'
}

/** What the topbar refresh button drives (the data owner holds the loader). */
export interface GitHistoryPanelDataHandle {
  refresh: () => void
}

/** Data owner for the three sections. Remounts when `cwd` changes (the page
 * keys the mount by cwd), so no state crosses a repository boundary. */
const GitHistoryPanelData = forwardRef<GitHistoryPanelDataHandle, {
  cwd: string
  model: SessionModelSelection | undefined
  t: GitPanelTranslator
  pushToast: (text: string, tone: PanelToast['tone']) => void
  /** Reads the cn-accelerate switch at toast time (stable reference). */
  accelOn: () => boolean
}>(function GitHistoryPanelData(props, ref): JSX.Element {
  const { cwd, model, t, pushToast, accelOn } = props
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [statusError, setStatusError] = useState<string | undefined>()
  const [changes, setChanges] = useState<WorktreeChange[]>([])
  const [changesTruncated, setChangesTruncated] = useState(false)
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesByHash, setFilesByHash] = useState<Readonly<Record<string, CommitFilesState>>>({})
  const [sectionBusy, setSectionBusy] = useState(false)
  /** The remote-address editor (branch card's 「管理远程」 entry). */
  const [remotesOpen, setRemotesOpen] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [commitMenuOpen, setCommitMenuOpen] = useState(false)
  const [commitDraft, setCommitDraft] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  /** The history card's filters. They live HERE, not in the section, because
   * they are request parameters: the section renders them and hands every
   * change up, and the loader below re-walks the log with them. */
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS)

  /** Response-sequence guard: a refresh raced against a mutation or a cwd
   * change must never land an older snapshot over a newer one. */
  const seqRef = useRef(0)

  const loadHistoryPage = useCallback(async (skip: number): Promise<{ commits: CommitEntry[]; complete: boolean } | undefined> => {
    // Filters are resolved against the wall clock HERE, per request: a
    // "last 24 hours" window must not freeze at the moment the panel opened.
    const result = await requestLog(cwd, historyQueryFor(historyFilters, Date.now(), HISTORY_PAGE, skip))
    if (!result.ok) {
      setHistoryError(result.error)
      return undefined
    }
    setHistoryError(undefined)
    return { commits: result.commits, complete: result.commits.length < HISTORY_PAGE }
  }, [cwd, historyFilters])

  const loadAll = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1
    seqRef.current = seq
    setHistoryLoading(true)
    const [statusResult, changesResult, logPage] = await Promise.all([
      fetchStatus(cwd),
      requestChanges(cwd),
      loadHistoryPage(0),
    ])
    if (seq !== seqRef.current) return
    if (statusResult.ok) {
      setStatus(statusResult)
      setStatusError(undefined)
    } else {
      setStatus(null)
      setStatusError(statusResult.error)
    }
    setChanges(changesResult.ok ? changesResult.changes : [])
    setChangesTruncated(changesResult.ok && changesResult.truncated === true)
    if (logPage !== undefined) {
      setCommits(logPage.commits)
      setHasMore(!logPage.complete)
      setHistoryLoaded(true)
    }
    setHistoryLoading(false)
  }, [cwd, loadHistoryPage])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const refresh = useCallback((): void => {
    void loadAll()
  }, [loadAll])

  // The composer chip owns the other half of the same repository: a chip
  // checkout/rename reaches this panel only through the shared notice.
  // Self-emitted events land here too — loadAll is an idempotent re-read
  // guarded by the request sequence, so the echo costs one extra fetch
  // and never a wrong snapshot.
  useEffect(() => onGitMutated(refresh), [refresh])

  // The topbar refresh button sits in the page chrome while the loader lives
  // here; expose the verb upward through the handle.
  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  const repo = status !== null && status.repo ? status : null

  /** Run one mutating verb with the section-busy guard and error toast.
   * Mutations refresh through `loadAll` so their re-read bumps the request
   * sequence — an older in-flight snapshot can never land over the fresh
   * post-mutation state. A SUCCESS also emits the cross-surface notice so
   * the composer chip drops the branch git just left (stage toggles ride
   * along — one extra idempotent /status beats per-verb wiring). */
  const runGuarded = useCallback(async (verb: () => Promise<void>): Promise<void> => {
    setSectionBusy(true)
    try {
      await verb()
      emitGitMutated()
    } catch (error) {
      pushToast(t('errorGeneric', { message: failureText(error) }), 'error')
    } finally {
      setSectionBusy(false)
    }
  }, [pushToast, t])

  const onToggleRow = useCallback((row: ChangeRow): void => {
    void runGuarded(async () => {
      const paths = row.oldPath === undefined ? [row.path] : [row.path, row.oldPath]
      const result = await requestStage(cwd, paths, !row.staged)
      if (!result.ok) throw new Error(result.error)
      await loadAll()
    })
  }, [cwd, loadAll, runGuarded])

  // Unstage needs BOTH paths of a rename (git reset clears the index pair);
  // staging must NOT carry the old path — it is gone from the worktree and
  // `git add` errors on a pathspec matching nothing.
  const stagePathsOf = (rows: readonly ChangeRow[], includeOldPath: boolean): string[] => {
    const paths: string[] = []
    for (const row of rows) {
      paths.push(row.path)
      if (includeOldPath && row.oldPath !== undefined) paths.push(row.oldPath)
    }
    return [...new Set(paths)]
  }

  const onStageAll = useCallback((): void => {
    void runGuarded(async () => {
      const result = await requestStage(cwd, stagePathsOf(groupChanges(changes).unstaged, false), true)
      if (!result.ok) throw new Error(result.error)
      await loadAll()
    })
  }, [changes, cwd, loadAll, runGuarded])

  const onUnstageAll = useCallback((): void => {
    void runGuarded(async () => {
      const result = await requestStage(cwd, stagePathsOf(groupChanges(changes).staged, true), false)
      if (!result.ok) throw new Error(result.error)
      await loadAll()
    })
  }, [changes, cwd, loadAll, runGuarded])

  const onCommit = useCallback((push: boolean): void => {
    const message = commitDraft.trim()
    if (message === '') return
    void runGuarded(async () => {
      const result = await requestCommit(cwd, message)
      if (!result.ok) throw new Error(result.error)
      setCommitDraft('')
      setCommitMenuOpen(false)
      if (!push) {
        pushToast(t('panel.commitDone', { subject: result.subject }), 'success')
        await loadAll()
        return
      }
      // The push settles before ANY success copy: 「已提交并推送」 on screen
      // while the push is still in flight read as premature, and a later
      // failure read as double-reporting. The commit itself is never
      // un-reported — its toast degrades to 已提交 when the push does not
      // land.
      try {
        const pushResult = await requestPush(cwd)
        if (!pushResult.ok) {
          pushToast(t('panel.commitDone', { subject: result.subject }), 'success')
          pushToast(t('errorGeneric', { message: pushResult.error }), 'error')
        } else {
          // pushed, or the remote already carried the commit — either way
          // it is there now.
          pushToast(t('panel.commitPushDone', { subject: result.subject }), 'success')
        }
      } catch (error) {
        pushToast(t('panel.commitDone', { subject: result.subject }), 'success')
        pushToast(t('errorGeneric', { message: failureText(error) }), 'error')
      }
      await loadAll()
    })
  }, [commitDraft, cwd, loadAll, pushToast, runGuarded, t])

  const onAiGenerate = useCallback((): void => {
    if (model === undefined || aiBusy) return
    setAiBusy(true)
    void (async () => {
      try {
        const result = await requestAiCommitMessage({
          repoPath: cwd,
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { effort: model.reasoningEffort }),
          ...(commitDraft.trim() === '' ? {} : { hint: commitDraft.trim() }),
        })
        if (!result.ok) {
          pushToast(t('panel.aiFailed', { message: result.error }), 'error')
          return
        }
        setCommitDraft(result.message)
        pushToast(t('panel.aiDone'), 'success')
      } catch (error) {
        pushToast(t('panel.aiFailed', { message: failureText(error) }), 'error')
      } finally {
        setAiBusy(false)
      }
    })()
  }, [aiBusy, commitDraft, cwd, model, pushToast, t])

  /** Fetch/update failure toast text: the git failure line, plus the
   * mirror-unavailable hint while cn-accelerate is on (push is never
   * accelerated, so its failures stay hint-free). */
  const syncFailureText = useCallback((message: string): string => {
    const generic = t('errorGeneric', { message })
    return accelOn() ? `${generic} ${t('accel.mirrorDownHint')}` : generic
  }, [accelOn, t])

  const onFetch = useCallback((): void => {
    setSyncBusy(true)
    void (async () => {
      try {
        const result = await requestFetch(cwd)
        if (!result.ok) pushToast(syncFailureText(result.error), 'error')
        else {
          pushToast(t('fetchDone'), 'success')
          emitGitMutated()
        }
        await loadAll()
      } finally {
        setSyncBusy(false)
      }
    })()
  }, [cwd, loadAll, pushToast, syncFailureText, t])

  const onUpdate = useCallback((): void => {
    setSyncBusy(true)
    void (async () => {
      try {
        const result = await requestUpdate(cwd)
        if (!result.ok) pushToast(syncFailureText(result.error), 'error')
        else {
          pushToast(result.updated ? t('updateDone', { branch: result.branch }) : t('updateUpToDate'), 'success')
          emitGitMutated()
        }
        await loadAll()
      } finally {
        setSyncBusy(false)
      }
    })()
  }, [cwd, loadAll, pushToast, syncFailureText, t])

  const onPush = useCallback((): void => {
    setSyncBusy(true)
    void (async () => {
      try {
        const result = await requestPush(cwd)
        if (!result.ok) pushToast(t('errorGeneric', { message: result.error }), 'error')
        else {
          pushToast(result.pushed ? t('pushDone', { branch: result.branch }) : t('pushUpToDate'), 'success')
          emitGitMutated()
        }
        await loadAll()
      } finally {
        setSyncBusy(false)
      }
    })()
  }, [cwd, loadAll, pushToast, t])

  const onCheckout = useCallback((branch: BranchRow): void => {
    void runGuarded(async () => {
      const result = await requestSwitch(cwd, branch.name)
      if (!result.ok) throw new Error(result.error)
      pushToast(t('panel.checkoutDone', { branch: result.branch }), 'success')
      await loadAll()
    })
  }, [cwd, loadAll, pushToast, runGuarded, t])

  const onRename = useCallback((branch: BranchRow, newName: string): void => {
    void runGuarded(async () => {
      const result = await requestRenameBranch(cwd, branch.name, newName)
      if (!result.ok) throw new Error(result.error)
      pushToast(t('panel.renameDone', { branch: result.branch }), 'success')
      await loadAll()
    })
  }, [cwd, loadAll, pushToast, runGuarded, t])

  const onDelete = useCallback((branch: BranchRow): void => {
    void runGuarded(async () => {
      const result = await requestDeleteBranch(cwd, branch.name)
      if (!result.ok) throw new Error(result.error)
      pushToast(t('panel.deleteDone', { branch: result.branch }), 'success')
      await loadAll()
    })
  }, [cwd, loadAll, pushToast, runGuarded, t])

  const onCreate = useCallback((name: string, from?: string): void => {
    void runGuarded(async () => {
      const result = await requestCreateBranch(cwd, name, from)
      if (!result.ok) throw new Error(result.error)
      pushToast(t('panel.createDone', { branch: result.branch }), 'success')
      await loadAll()
    })
  }, [cwd, loadAll, pushToast, runGuarded, t])

  /** Tag one commit. Runs against the repository (a tag is a repository-wide
   * ref), so the history card can tag a commit that no checkout has. Only
   * local: pushing tags is a release step, not a side effect of a right-click. */
  const onCreateTag = useCallback((name: string, target: string, message: string): void => {
    void runGuarded(async () => {
      const result = await requestCreateTag(cwd, name, target, message)
      if (!result.ok) throw new Error(result.error)
      pushToast(t('panel.tagDone', { tag: result.tag }), 'success')
      await loadAll()
    })
  }, [cwd, loadAll, pushToast, runGuarded, t])

  /** Publish ONE local tag. Its own verb, apart from the branch push: `git
   * push` sends the branch alone, so a tag made on an already-pushed commit
   * would otherwise never reach the remote. Deliberately no refetch: tags are
   * local refs and a remote tag changes nothing the panel can see. */
  const onPushTag = useCallback((name: string): void => {
    void runGuarded(async () => {
      const result = await requestPushTag(cwd, name)
      if (!result.ok) throw new Error(result.error)
      pushToast(
        result.pushed
          ? t('panel.tagPushDone', { tag: result.tag, remote: result.remote })
          : t('panel.tagPushUpToDate', { tag: result.tag, remote: result.remote }),
        'success',
      )
    })
  }, [cwd, pushToast, runGuarded, t])

  const onToggleCommit = useCallback((hash: string): void => {
    if (expanded === hash) {
      setExpanded(null)
      return
    }
    setExpanded(hash)
    if (filesByHash[hash] !== undefined) return
    setFilesByHash(prev => ({ ...prev, [hash]: { kind: 'loading' } }))
    void (async () => {
      const result = await requestCommitFiles(cwd, hash)
      setFilesByHash(prev => ({
        ...prev,
        [hash]: result.ok
          ? { kind: 'loaded', files: result.files }
          : { kind: 'failed', message: result.error },
      }))
    })()
  }, [cwd, expanded, filesByHash])

  const onLoadMore = useCallback((): void => {
    if (loadingMore) return
    setLoadingMore(true)
    // A full reload (refresh, commit, checkout) invalidates the page window
    // this request was sized against — drop its answer on arrival.
    const seq = seqRef.current
    void (async () => {
      try {
        const page = await loadHistoryPage(commits.length)
        if (seq !== seqRef.current) return
        if (page !== undefined) {
          setCommits(prev => appendPage(prev, page.commits))
          setHasMore(!page.complete)
        }
      } finally {
        setLoadingMore(false)
      }
    })()
  }, [commits.length, loadHistoryPage, loadingMore])

  const onHistoryFilters = useCallback((next: HistoryFilters): void => {
    // Setting the filters re-creates `loadHistoryPage`, which re-runs
    // `loadAll` through its effect — so the new window walks from page 0 and
    // any in-flight page is dropped by the sequence guard.
    setHistoryFilters(next)
    setExpanded(null)
  }, [])

  if (statusError !== undefined && repo === null) {
    return (
      <div>
        <div className={css.errorText}>{t('panel.loadFailed', { message: statusError })}</div>
        <div className={css.moreRow}>
          <button type="button" className={css.act} onClick={refresh}>{t('panel.retry')}</button>
        </div>
      </div>
    )
  }

  // The status call SUCCEEDED but the directory is not a repository: that is
  // the documented empty state, not a loading state.
  if (status !== null && status.repo === false) {
    return <div className={css.empty}>{t('panel.notARepo')}</div>
  }

  if (repo === null) {
    return <div className={css.empty}>{t('manager.loading')}</div>
  }

  const grouped = groupChanges(changes)
  // The local tree reads the picker list (with upstream tracks); the remote
  // tree reads the FULL remote view (local twins included) — origin/main is
  // a real remote branch even while `main` exists locally. Older hosts
  // serving /status without remoteBranches fall back to the deduped list.
  const rows = buildBranchRows(repo.branches, repo.currentBranch)
  const remoteRows = buildBranchRows(
    repo.remoteBranches ?? repo.branches.filter(branch => branch.kind === 'remote'),
    '',
  ).remotes

  return (
    <div className={css.scroll}>
      <UncommittedSection
        t={t}
        staged={grouped.staged}
        unstaged={grouped.unstaged}
        busy={sectionBusy}
        syncBusy={syncBusy}
        truncated={changesTruncated}
        commitDraft={commitDraft}
        onCommitDraft={setCommitDraft}
        commitMenuOpen={commitMenuOpen}
        onToggleCommitMenu={() => setCommitMenuOpen(open => !open)}
        onCommit={onCommit}
        onToggleRow={onToggleRow}
        onStageAll={onStageAll}
        onUnstageAll={onUnstageAll}
        aiAvailable={model !== undefined}
        aiBusy={aiBusy}
        onAiGenerate={onAiGenerate}
        onFetch={onFetch}
        onUpdate={onUpdate}
        onPush={onPush}
      />
      <BranchSection
        t={t}
        locals={rows.locals}
        remotes={remoteRows}
        busy={sectionBusy}
        onCheckout={onCheckout}
        onRename={onRename}
        onDelete={onDelete}
        onCreate={onCreate}
        onManageRemotes={() => setRemotesOpen(true)}
      />
      <HistorySection
        t={t}
        commits={commits}
        loaded={historyLoaded}
        loadError={historyError}
        loading={historyLoading}
        hasMore={hasMore}
        loadingMore={loadingMore}
        expanded={expanded}
        filesByHash={filesByHash}
        filters={historyFilters}
        branches={rows.locals.map(row => row.name)}
        busy={sectionBusy}
        onLoadMore={onLoadMore}
        onToggle={onToggleCommit}
        onFilters={onHistoryFilters}
        onCreateBranch={onCreate}
        onCreateTag={onCreateTag}
        onPushTag={onPushTag}
        pushToast={pushToast}
      />
      {remotesOpen
        ? (
          <RemotesModal
            repoPath={cwd}
            t={t}
            pushToast={pushToast}
            onClose={() => setRemotesOpen(false)}
            onChanged={() => void loadAll()}
          />
        )
        : null}
    </div>
  )
})

/** The registered better-sidebar tab's content: chrome + data owner, keyed
 * by cwd so a session switch starts every section from scratch. */
export function GitPanelTab(props: GitPanelTabProps): JSX.Element {
  const { ctx, scope, t, accel } = props
  // Session-derived facts: cwd comes from the tab scope (the session list
  // summary as fallback); the model-selection projection (next, falling
  // back to lastUsed) feeds the AI generator. Both uSES snapshots return
  // primitives or stable store references, so they never re-render
  // spuriously.
  const subscribe = useCallback(
    (listener: () => void) => ctx.sessions.list.subscribe(listener),
    [ctx],
  )
  const cwd = useSyncExternalStore(subscribe, () =>
    scope.cwd ?? ctx.sessions.list.getSnapshot().byId[scope.sessionId]?.cwd)
  const model = useSyncExternalStore(subscribe, () => {
    const selection = ctx.sessions.list.getSnapshot().projectionsBySession[scope.sessionId]?.values.modelSelection
    return selection === undefined ? undefined : selection.next ?? selection.lastUsed ?? undefined
  })
  const [toasts, setToasts] = useState<readonly PanelToast[]>([])
  const toastSeq = useRef(0)
  const dataRef = useRef<GitHistoryPanelDataHandle | null>(null)
  const pushToast = useCallback((text: string, tone: PanelToast['tone']): void => {
    toastSeq.current += 1
    const seq = toastSeq.current
    setToasts(queue => [...queue, { seq, text, tone }])
  }, [])
  // Cn-accelerate: the button reflects the stored switch; its popover edits
  // the shared staged form. Closing the popover (toggle, Esc, outside click,
  // 取消) discards the staged edits — the form is one-shot by save.
  const accelState = useSyncExternalStore(accel.store.subscribe, accel.store.getSnapshot)
  const [accelOpen, setAccelOpen] = useState(false)
  // The credential editor is GLOBAL (one row per remote host), so it hangs
  // off the chrome rather than a repository and opens with or without a tab
  // cwd. Its list arrives from the host half, never from the tab's status.
  const [credOpen, setCredOpen] = useState(false)
  const accelOn = useCallback(() => accel.store.getSnapshot().enabled, [accel])
  const closeAccel = useCallback(() => {
    accel.discardAccel()
    setAccelOpen(false)
  }, [accel])

  return (
    <div className={css.page}>
      <header className={css.topbar}>
        {cwd !== undefined ? <span className={css.repoPill}><span className={css.repoName}>{cwd}</span></span> : null}
        <div className={css.topbarActions}>
          <div className={css.cnWrap}>
            <button
              type="button"
              className={accelState.enabled ? css.cnBtnOn : css.cnBtn}
              title={t('panel.cnAccelerate')}
              aria-label={t('panel.cnAccelerate')}
              aria-expanded={accelOpen}
              onClick={() => (accelOpen ? closeAccel() : setAccelOpen(true))}
            >
              <span aria-hidden="true">⚡</span>
              <span>{t('panel.cnAccelerate')}</span>
              {accelState.enabled ? <span className={css.cnDot} aria-hidden="true" /> : null}
            </button>
            {accelOpen
              ? <CnAcceleratePopover accel={accel} t={t} pushToast={pushToast} onClose={closeAccel} />
              : null}
          </div>
          <button
            type="button"
            className={credOpen ? css.cnBtnOn : css.cnBtn}
            title={t('panel.credentials')}
            aria-label={t('panel.credentials')}
            aria-expanded={credOpen}
            onClick={() => setCredOpen(open => !open)}
          >
            <span aria-hidden="true">🔑</span>
            <span>{t('panel.credentials')}</span>
          </button>
          <button
            type="button"
            className={css.refreshBtn}
            disabled={cwd === undefined}
            title={t('panel.refresh')}
            aria-label={t('panel.refresh')}
            onClick={() => dataRef.current?.refresh()}
          >
            <IconRefreshOutlineRegular size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      {credOpen
        ? <CredentialModal t={t} pushToast={pushToast} onClose={() => setCredOpen(false)} />
        : null}
      {cwd === undefined
        ? <div className={css.empty}>{t('panel.noSession')}</div>
        : <GitHistoryPanelData key={cwd} ref={dataRef} cwd={cwd} model={model} t={t} pushToast={pushToast} accelOn={accelOn} />}
      {toasts.map(toast => (
        <Toast
          key={String(toast.seq)}
          text={toast.text}
          {...(toast.tone === 'success' ? { tone: 'success' as const } : {})}
          onDone={() => setToasts(queue => queue.filter(entry => entry.seq !== toast.seq))}
        />
      ))}
    </div>
  )
}
