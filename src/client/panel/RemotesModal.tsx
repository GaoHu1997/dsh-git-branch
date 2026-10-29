/**
 * RemotesModal: the repository's remote-address editor (behind the branch
 * section's 「管理远程」 button).
 *
 * A remote belongs to the REPOSITORY, not to a worktree, so this dialog
 * mutates `.git/config` through the plugin's remote routes and then reports
 * the fresh list back to the caller — the panel reloads its branch rows so
 * a new remote's branches show up without a manual refresh.
 *
 * Every mutation returns the complete list (the host half re-reads
 * `git remote -v` after writing), so the dialog never guesses what changed.
 * Names are immutable here: `git remote rename` also rewrites tracking
 * config, which this panel does not offer; the URL is the mutable part.
 *
 * @module git-worktree/client/panel/RemotesModal
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteEntry } from '../../wire.ts'
import { requestMutateRemote, requestRemotes } from '../api.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import css from '../GitHistoryPanel.module.css'

/** The dialog's props: the repository whose remotes are edited, the panel
 * translator, the toast queue, and a close callback. `onChanged` fires after
 * every successful write so the branch list can reload. */
export interface RemotesModalProps {
  repoPath: string
  t: GitPanelTranslator
  pushToast: (text: string, tone: 'success' | 'error') => void
  onClose: () => void
  onChanged?: () => void
}

/** The remote editor dialog. */
export function RemotesModal(props: RemotesModalProps): JSX.Element {
  const { repoPath, t, pushToast, onClose, onChanged } = props
  const [remotes, setRemotes] = useState<readonly RemoteEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  /** The remote whose URL is being rewritten (undefined = adding a new one). */
  const [editing, setEditing] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  /** Two-step remove: the first click only arms the row. */
  const [confirmName, setConfirmName] = useState<string | undefined>()

  const load = useCallback(async (): Promise<void> => {
    const result = await requestRemotes(repoPath)
    if (!result.ok) {
      setLoadError(result.error)
      setLoaded(true)
      return
    }
    setRemotes(result.remotes)
    setLoadError(undefined)
    setLoaded(true)
  }, [repoPath])

  useEffect(() => {
    void load()
  }, [load])

  const resetEditor = useCallback((): void => {
    setEditing(undefined)
    setName('')
    setUrl('')
    setFormError(undefined)
    setConfirmName(undefined)
  }, [])

  const startEdit = useCallback((entry: RemoteEntry): void => {
    setEditing(entry.name)
    setName(entry.name)
    setUrl(entry.fetchUrl)
    setFormError(undefined)
    setConfirmName(undefined)
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    if (name.trim() === '') {
      setFormError(t('remotes.nameEmpty'))
      return
    }
    if (url.trim() === '') {
      setFormError(t('remotes.urlEmpty'))
      return
    }
    setBusy(true)
    const result = await requestMutateRemote({
      repoPath,
      action: editing === undefined ? 'add' : 'set-url',
      name: name.trim(),
      url: url.trim(),
    })
    setBusy(false)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setRemotes(result.remotes)
    pushToast(t('remotes.saved', { name: name.trim() }), 'success')
    resetEditor()
    onChanged?.()
  }, [busy, editing, name, onChanged, pushToast, repoPath, resetEditor, t, url])

  const remove = useCallback(
    async (target: string): Promise<void> => {
      if (busy) return
      setBusy(true)
      const result = await requestMutateRemote({ repoPath, action: 'remove', name: target })
      setBusy(false)
      if (!result.ok) {
        setFormError(result.error)
        setConfirmName(undefined)
        return
      }
      setRemotes(result.remotes)
      pushToast(t('remotes.removed', { name: target }), 'success')
      setConfirmName(undefined)
      if (editing === target) resetEditor()
      onChanged?.()
    },
    [busy, editing, onChanged, pushToast, repoPath, resetEditor, t],
  )

  const editorTitle = editing === undefined ? t('remotes.add') : `${t('remotes.edit')} · ${editing}`

  return (
    <Modal
      open
      onClose={onClose}
      title={t('remotes.title')}
      closeLabel={t('remotes.cancel')}
      footer={<Button size="sm" variant="ghost" onClick={onClose}>{t('cancel')}</Button>}
    >
      <p className={css.credHint}>{t('remotes.hint')}</p>
      {loadError !== undefined ? <div className={css.formError}>{loadError}</div> : null}
      {loaded && loadError === undefined && remotes.length === 0
        ? <p className={css.empty}>{t('remotes.empty')}</p>
        : null}
      {remotes.length > 0
        ? (
          <div className={css.credList}>
            {remotes.map(entry => (
              <div key={entry.name} className={css.credRow}>
                <div className={css.credMain}>
                  <span className={css.credHost}>{entry.name}</span>
                  <span className={css.credMeta}>
                    {entry.fetchUrl === entry.pushUrl
                      ? entry.fetchUrl
                      : `${t('remotes.fetchUrl')}: ${entry.fetchUrl} · ${t('remotes.pushUrl')}: ${entry.pushUrl}`}
                  </span>
                </div>
                <div className={css.credActions}>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(entry)}>{t('remotes.edit')}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => (confirmName === entry.name ? void remove(entry.name) : setConfirmName(entry.name))}
                  >
                    {confirmName === entry.name ? t('remotes.confirmRemove') : t('remotes.remove')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )
        : null}
      <div className={css.credDivider} />
      <div className={css.credFormTitle}>{editorTitle}</div>
      <div className={css.credForm}>
        <div className={css.formField}>
          <label className={css.formLabel} htmlFor="git-remote-name">{t('remotes.nameLabel')}</label>
          <input
            id="git-remote-name"
            className={css.formInput}
            value={name}
            placeholder={t('remotes.namePlaceholder')}
            readOnly={editing !== undefined}
            data-modal-autofocus={editing === undefined ? true : undefined}
            onChange={event => setName(event.target.value)}
          />
        </div>
        <div className={css.formField}>
          <label className={css.formLabel} htmlFor="git-remote-url">{t('remotes.urlLabel')}</label>
          <input
            id="git-remote-url"
            className={css.formInput}
            value={url}
            placeholder={t('remotes.urlPlaceholder')}
            onChange={event => setUrl(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void submit()
            }}
          />
        </div>
        <div className={css.formError}>{formError ?? ''}</div>
      </div>
      <div className={css.credFooter}>
        {editing !== undefined
          ? <Button size="sm" variant="ghost" onClick={resetEditor}>{t('remotes.cancel')}</Button>
          : null}
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? t('remotes.saving') : t('remotes.save')}
        </Button>
      </div>
    </Modal>
  )
}
