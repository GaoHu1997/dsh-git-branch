/**
 * CredentialModal: the GLOBAL git credential editor behind the topbar's
 * 「密钥配置」 button.
 *
 * Credentials are keyed by remote HOST, not by repository: one github.com
 * token serves every checkout on this machine. The list therefore never
 * shows a secret — the host routes return a mask only — and the editor
 * treats an empty secret as "keep the stored one", which is why the field's
 * placeholder changes once a host already has a credential.
 *
 * Validation is split: this component only rejects empty fields (instant
 * feedback); the host/secret shape is decided by the host half
 * (normalizeCredentialHost), whose message rides the error envelope back
 * here. Nothing in this file imports `../../credentials.ts` — that module
 * touches node:fs, which has no place in the browser bundle.
 *
 * @module git-worktree/client/panel/CredentialModal
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CredentialEntryView, CredentialMethod } from '../../wire.ts'
import { requestCredentials, requestDeleteCredential, requestSaveCredential } from '../api.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import css from '../GitHistoryPanel.module.css'

/** The hosts the dialog offers as one-click presets (custom hosts are typed
 * in by hand and validated host-side). */
const PRESET_HOSTS: readonly string[] = ['github.com', 'gitlab.com', 'gitee.com']

/** Where each preset host mints a token. Only token-based hosts get a link:
 * a self-hosted GitLab or Gitee clone has no well-known settings page. */
const TOKEN_PAGES: Readonly<Record<string, string>> = {
  'github.com': 'https://github.com/settings/tokens/new?description=dsh-git-branch',
  'gitlab.com': 'https://gitlab.com/-/user_settings/personal_access_tokens',
  'gitee.com': 'https://gitee.com/profile/personal_access_tokens',
}

/** One open editor: which stored host it rewrites (undefined = new host). */
type EditorSeed = CredentialEntryView | undefined

/** The dialog's props: the panel translator, its toast queue, and close. */
export interface CredentialModalProps {
  t: GitPanelTranslator
  pushToast: (text: string, tone: 'success' | 'error') => void
  onClose: () => void
}

/** The credential editor dialog. Loads the global list on mount and after
 * every write; each write returns the fresh masked list, so no reload loop
 * (and no stale row) is possible. */
export function CredentialModal(props: CredentialModalProps): JSX.Element {
  const { t, pushToast, onClose } = props
  const [entries, setEntries] = useState<readonly CredentialEntryView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [method, setMethod] = useState<CredentialMethod>('password')
  const [secret, setSecret] = useState('')
  const [seed, setSeed] = useState<EditorSeed>()
  const [formError, setFormError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  /** Two-step delete: the first click only arms the row. */
  const [confirmHost, setConfirmHost] = useState<string | undefined>()
  /** The editor starts collapsed; the "+" icon in the header row opens it,
   * and the row's 编辑 button re-opens it prefilled. Keeping the form out of
   * the DOM until it is asked for leaves the list as the modal's default. */
  const [editorOpen, setEditorOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await requestCredentials()
    if (!result.ok) {
      setLoadError(result.error)
      setLoaded(true)
      return
    }
    setEntries(result.credentials)
    setLoadError(undefined)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const applyEditor = useCallback((next: EditorSeed): void => {
    setSeed(next)
    setHost(next === undefined ? '' : next.host)
    setUsername(next === undefined ? '' : next.username)
    setMethod(next === undefined ? 'password' : next.method)
    setSecret('')
    setFormError(undefined)
    setConfirmHost(undefined)
  }, [])

  const openNew = useCallback((): void => {
    applyEditor(undefined)
    setEditorOpen(true)
  }, [applyEditor])

  /** Cancel closes the form only; the modal keeps the list it was opened for. */
  const closeEditor = useCallback((): void => {
    applyEditor(undefined)
    setEditorOpen(false)
  }, [applyEditor])

  // Presets fill the host and, when that host is already stored, switch the
  // editor into "edit" mode so the username and method arrive prefilled.
  const applyPreset = useCallback(
    (preset: string): void => {
      const existing = entries.find(entry => entry.host === preset)
      if (existing !== undefined) {
        applyEditor(existing)
        return
      }
      applyEditor(undefined)
      setHost(preset)
      setMethod('password')
    },
    [applyEditor, entries],
  )

  const normalizedHost = host.trim().toLowerCase()
  const existing = entries.find(entry => entry.host === normalizedHost)
  const tokenPage = TOKEN_PAGES[normalizedHost]

  const save = useCallback(async (): Promise<void> => {
    if (busy) return
    const trimmedSecret = secret.trim()
    if (host.trim() === '') {
      setFormError(t('cred.hostEmpty'))
      return
    }
    // Token mode needs no username: a personal access token authenticates on
    // its own and the host fills in a placeholder name. Only a password pair
    // needs a real login name.
    if (method === 'password' && username.trim() === '') {
      setFormError(t('cred.usernameEmpty'))
      return
    }
    if (existing === undefined && trimmedSecret === '') {
      setFormError(t('cred.secretEmpty'))
      return
    }
    setBusy(true)
    const result = await requestSaveCredential({
      host: host.trim(),
      username: username.trim(),
      method,
      ...(trimmedSecret === '' ? {} : { secret: trimmedSecret }),
    })
    setBusy(false)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setEntries(result.credentials)
    pushToast(t('cred.saved', { host: host.trim() }), 'success')
    applyEditor(undefined)
    setEditorOpen(false)
  }, [applyEditor, busy, existing, host, method, pushToast, secret, t, username])

  const remove = useCallback(
    async (target: string): Promise<void> => {
      if (busy) return
      setBusy(true)
      const result = await requestDeleteCredential({ host: target })
      setBusy(false)
      if (!result.ok) {
        setFormError(result.error)
        setConfirmHost(undefined)
        return
      }
      setEntries(result.credentials)
      pushToast(t('cred.deleted', { host: target }), 'success')
      setConfirmHost(undefined)
      if (seed?.host === target) {
        applyEditor(undefined)
        setEditorOpen(false)
      }
    },
    [applyEditor, busy, pushToast, seed, t],
  )

  const title = seed === undefined ? t('cred.add') : t('cred.edit')

  return (
    <Modal
      open
      onClose={onClose}
      title={t('cred.title')}
      closeLabel={t('cred.cancel')}
      footer={<Button size="sm" variant="ghost" onClick={onClose}>{t('close')}</Button>}
    >
      <div className={css.credTop}>
        <p className={css.credHint}>{t('cred.hint')}</p>
        <button
          type="button"
          className={css.credAdd}
          title={t('cred.add')}
          aria-label={t('cred.add')}
          aria-expanded={editorOpen}
          onClick={openNew}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      {loadError !== undefined ? <div className={css.formError}>{loadError}</div> : null}
      {loaded && loadError === undefined && entries.length === 0
        ? <p className={css.empty}>{t('cred.empty')}</p>
        : null}
      {entries.length > 0
        ? (
          <div className={css.credList}>
            {entries.map(entry => (
              <div key={entry.host} className={css.credRow}>
                <div className={css.credMain}>
                  <span className={css.credHost}>{entry.host}</span>
                  <span className={css.credMeta}>
                    {entry.username === '' ? null : <>{entry.username}{' · '}</>}
                    {entry.method === 'token' ? t('cred.methodToken') : t('cred.methodPassword')}
                    {' · '}
                    <code>{entry.secretMask}</code>
                  </span>
                </div>
                <div className={css.credActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      applyEditor(entry)
                      setEditorOpen(true)
                    }}
                  >
                    {t('cred.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => (confirmHost === entry.host ? void remove(entry.host) : setConfirmHost(entry.host))}
                  >
                    {confirmHost === entry.host ? t('cred.confirmDelete') : t('cred.delete')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )
        : null}
      {editorOpen
        ? (
          <>
            <div className={css.credDivider} />
            <div className={css.credFormTitle}>{title}</div>
            <div className={css.credForm}>
              <div className={css.credPresets}>
                <span className={css.credPresetLabel}>{t('cred.presets')}</span>
                {PRESET_HOSTS.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className={normalizedHost === preset ? css.credPresetOn : css.credPreset}
                    onClick={() => applyPreset(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div className={css.formField}>
                <label className={css.formLabel} htmlFor="git-credential-host">{t('cred.hostLabel')}</label>
                <input
                  id="git-credential-host"
                  className={css.formInput}
                  value={host}
                  placeholder={t('cred.hostPlaceholder')}
                  data-modal-autofocus={seed === undefined ? true : undefined}
                  onChange={event => setHost(event.target.value)}
                />
              </div>
              <div className={css.formField}>
                <span className={css.formLabel}>{t('cred.method')}</span>
                <div className={css.credMethodRow}>
                  <button
                    type="button"
                    aria-pressed={method === 'password'}
                    className={method === 'password' ? css.credMethodOn : css.credMethod}
                    onClick={() => setMethod('password')}
                  >
                    {t('cred.methodPassword')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={method === 'token'}
                    className={method === 'token' ? css.credMethodOn : css.credMethod}
                    onClick={() => setMethod('token')}
                  >
                    {t('cred.methodToken')}
                  </button>
                </div>
              </div>
              {/* A password pair needs a login name; a token authenticates on
                * its own, so the field is absent rather than merely optional. */}
              {method === 'password'
                ? (
                  <div className={css.formField}>
                    <label className={css.formLabel} htmlFor="git-credential-username">{t('cred.usernameLabel')}</label>
                    <input
                      id="git-credential-username"
                      className={css.formInput}
                      value={username}
                      placeholder={t('cred.usernamePlaceholder')}
                      onChange={event => setUsername(event.target.value)}
                    />
                  </div>
                )
                : null}
              <div className={css.formField}>
                <div className={css.credFieldHead}>
                  <label className={css.formLabel} htmlFor="git-credential-secret">
                    {method === 'token' ? t('cred.secretTokenLabel') : t('cred.secretPasswordLabel')}
                  </label>
                  {method === 'token' && tokenPage !== undefined
                    ? <a className={css.credLink} href={tokenPage} target="_blank" rel="noreferrer">{t('cred.getToken')}</a>
                    : null}
                </div>
                <input
                  id="git-credential-secret"
                  className={css.formInput}
                  type="password"
                  value={secret}
                  placeholder={existing === undefined ? t('cred.secretPlaceholder') : t('cred.secretKeep')}
                  onChange={event => setSecret(event.target.value)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void save()
                  }}
                />
              </div>
              <div className={css.formError}>{formError ?? ''}</div>
            </div>
            <div className={css.credFooter}>
              <Button size="sm" variant="outline" onClick={closeEditor}>{t('cancel')}</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? t('cred.saving') : t('cred.save')}
              </Button>
            </div>
          </>
        )
        : null}
    </Modal>
  )
}
