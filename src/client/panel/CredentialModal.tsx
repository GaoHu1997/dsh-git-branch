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
 * Authentication has two paths and no password pair: device-flow hosts open
 * the browser (the token lands host-side, so the dialog only sees the mask),
 * every other host takes a pasted token. GitHub retired password auth in
 * 2021 and GitLab/Gitee expect a PAT, so a username/password form only
 * collected credentials the hosts reject.
 *
 * @module git-worktree/client/panel/CredentialModal
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CredentialEntryView } from '../../wire.ts'
import { BROWSER_SIGN_IN_HOSTS } from '../../wire.ts'
import { requestCredentials, requestDeleteCredential, requestOAuthPoll, requestOAuthStart, requestSaveCredential } from '../api.ts'
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

/** The two authentication paths the editor offers: an interactive browser
 * sign-in (device flow), or a personal access token pasted by hand. Password
 * pairs are gone — GitHub dropped them in 2021 and GitLab/Gitee expect a PAT,
 * so a username/password form only invited credentials the hosts reject. */
type AuthMode = 'browser' | 'token'

/** The browser sign-in lifecycle the dialog renders. */
type OAuthPhase = 'idle' | 'connecting' | 'waiting'

/** What the dialog knows while a browser sign-in runs. */
interface OAuthState {
  phase: OAuthPhase
  /** The one-time code the user types on the opened verification page. */
  userCode?: string
  /** The verification page, kept as a fallback link while waiting. */
  verificationUri?: string
}

/** One polling interval, kept as a promise so the loop stays sequential. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** Consecutive unreachable polls before the dialog gives up. One TLS blip —
 * the reset keep-alive connection this environment sees — must not discard a
 * grant the user already approved in the browser. */
const OAUTH_NETWORK_RETRY_LIMIT = 5

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
  const [method, setMethod] = useState<AuthMode>('token')
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
  /** The browser sign-in currently shown under the password fields. */
  const [oauth, setOauth] = useState<OAuthState>({ phase: 'idle' })
  /** Generation counter: one bump abandons an in-flight poll loop (cancel,
   * close, unmount), so a late answer cannot revive a closed editor. */
  const oauthRun = useRef(0)

  useEffect(() => () => {
    oauthRun.current += 1
  }, [])

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
    // Re-seeding the form abandons any browser sign-in it was showing.
    oauthRun.current += 1
    setOauth({ phase: 'idle' })
    setSeed(next)
    setHost(next === undefined ? '' : next.host)
    // A stored password credential opens on the browser path — its password
    // can no longer be edited here — while a token one opens on the field.
    setMethod(next === undefined ? 'token' : next.method === 'token' ? 'token' : 'browser')
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

  /** Switching path abandons whatever sign-in the other path was waiting on,
   * so a late poll answer cannot rewrite the form the user now sees. */
  const chooseMode = useCallback(
    (next: AuthMode): void => {
      if (next === method) return
      oauthRun.current += 1
      setOauth({ phase: 'idle' })
      setMethod(next)
    },
    [method],
  )

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
      // A preset that can sign in through the browser opens on that path;
      // every other host only ever has a token to offer.
      setMethod(BROWSER_SIGN_IN_HOSTS.includes(preset) ? 'browser' : 'token')
    },
    [applyEditor, entries],
  )

  const normalizedHost = host.trim().toLowerCase()
  const existing = entries.find(entry => entry.host === normalizedHost)
  const tokenPage = TOKEN_PAGES[normalizedHost]
  /** Device flow is only implemented for a few hosts; the rest get the token
   * field alone, with no method switch that could promise a dead button. */
  const browserSignIn = BROWSER_SIGN_IN_HOSTS.includes(normalizedHost)
  /** The mode actually rendered: without device flow the token field wins,
   * whatever stale selection the form was carrying. */
  const authMode: AuthMode = browserSignIn ? method : 'token'

  const save = useCallback(async (): Promise<void> => {
    if (busy) return
    const trimmedSecret = secret.trim()
    if (host.trim() === '') {
      setFormError(t('cred.hostEmpty'))
      return
    }
    if (existing === undefined && trimmedSecret === '') {
      setFormError(t('cred.secretEmpty'))
      return
    }
    setBusy(true)
    // Only tokens are saved by hand: a browser sign-in stores its own token
    // host-side, which is why this editor no longer has username/password
    // fields to carry.
    const result = await requestSaveCredential({
      host: host.trim(),
      username: '',
      method: 'token',
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
  }, [applyEditor, busy, existing, host, pushToast, secret, t])

  /**
   * IDEA-style site sign-in: start a device-flow grant, open the verification
   * page, then poll until the user approves. The token is stored host-side,
   * so the dialog only ever receives the refreshed masked list.
   */
  const connect = useCallback(async (): Promise<void> => {
    if (busy || oauth.phase !== 'idle' || !browserSignIn) return
    const target = normalizedHost
    if (target === '') {
      setFormError(t('cred.hostEmpty'))
      return
    }
    const run = ++oauthRun.current
    setFormError(undefined)
    setOauth({ phase: 'connecting' })
    // Open the tab synchronously: after the await below the browser no longer
    // treats the call as user-initiated and would block the popup, which
    // matters most on the slow links this feature is meant to help with.
    const tab = window.open('', '_blank')
    const started = await requestOAuthStart({ host: target })
    if (oauthRun.current !== run) {
      tab?.close()
      return
    }
    if (!started.ok) {
      tab?.close()
      setOauth({ phase: 'idle' })
      setFormError(started.error)
      return
    }
    const page = started.verificationUriComplete ?? started.verificationUri
    if (tab === null || tab.closed) {
      // The placeholder tab was blocked or closed; a plain open is the fallback.
      window.open(page, '_blank', 'noopener,noreferrer')
    } else {
      tab.opener = null
      tab.location.href = page
    }
    setOauth({ phase: 'waiting', userCode: started.userCode, verificationUri: started.verificationUri })
    const deadline = Date.now() + started.expiresInSeconds * 1000
    let intervalMs = Math.max(started.intervalSeconds, 1) * 1000
    let networkFailures = 0
    while (Date.now() < deadline) {
      await delay(intervalMs)
      if (oauthRun.current !== run) return
      const polled = await requestOAuthPoll({ host: target, deviceCode: started.deviceCode })
      if (oauthRun.current !== run) return
      if (!polled.ok) {
        setOauth({ phase: 'idle' })
        setFormError(polled.error)
        return
      }
      if (polled.status === 'network') {
        // Transport trouble, not a verdict on the grant: keep polling, but
        // stop after a run of failures so a dead link reports instead of
        // spinning until the code expires.
        networkFailures += 1
        if (networkFailures >= OAUTH_NETWORK_RETRY_LIMIT) {
          setOauth({ phase: 'idle' })
          setFormError(t('cred.deviceNetwork', { host: target }))
          return
        }
        continue
      }
      networkFailures = 0
      if (polled.status === 'pending') continue
      if (polled.status === 'slow_down') {
        // GitHub asked for fewer polls; back off without abandoning the grant.
        intervalMs = Math.min(intervalMs * 2, 60_000)
        continue
      }
      setEntries(polled.credentials)
      setOauth({ phase: 'idle' })
      applyEditor(undefined)
      setEditorOpen(false)
      pushToast(t('cred.saved', { host: target }), 'success')
      return
    }
    if (oauthRun.current !== run) return
    setOauth({ phase: 'idle' })
    setFormError(t('cred.deviceExpired'))
  }, [applyEditor, browserSignIn, busy, normalizedHost, oauth.phase, pushToast, t])

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
              {/* Device-flow hosts offer two paths; every other host only has
                * a token, so the switch is not rendered at all. */}
              {browserSignIn
                ? (
                  <div className={css.formField}>
                    <span className={css.formLabel}>{t('cred.method')}</span>
                    <div className={css.credMethodRow}>
                      <button
                        type="button"
                        aria-pressed={authMode === 'browser'}
                        className={authMode === 'browser' ? css.credMethodOn : css.credMethod}
                        onClick={() => chooseMode('browser')}
                      >
                        {t('cred.methodBrowser')}
                      </button>
                      <button
                        type="button"
                        aria-pressed={authMode === 'token'}
                        className={authMode === 'token' ? css.credMethodOn : css.credMethod}
                        onClick={() => chooseMode('token')}
                      >
                        {t('cred.methodToken')}
                      </button>
                    </div>
                  </div>
                )
                : null}
              {authMode === 'token'
                ? (
                  <div className={css.formField}>
                    <div className={css.credFieldHead}>
                      <label className={css.formLabel} htmlFor="git-credential-secret">{t('cred.secretTokenLabel')}</label>
                    </div>
                    <div className={css.credSecretRow}>
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
                      {/* IDEA's token editor: a 「创建」 button at the end of the
                        * field jumps straight to the host's token page. */}
                      {tokenPage !== undefined
                        ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => window.open(tokenPage, '_blank', 'noopener,noreferrer')}
                          >
                            {t('cred.createToken')}
                          </Button>
                        )
                        : null}
                    </div>
                  </div>
                )
                : (
                  <div className={css.credOAuth}>
                    <span className={css.credDeviceHint}>{t('cred.browserHint')}</span>
                    {oauth.phase === 'idle'
                      ? (
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void connect()}>
                          {t('cred.connect')}
                        </Button>
                      )
                      : null}
                    {oauth.phase === 'connecting'
                      ? <span className={css.credDeviceHint}>{t('cred.connecting')}</span>
                      : null}
                    {oauth.phase === 'waiting'
                      ? (
                        <div className={css.credDevice}>
                          <div className={css.credDeviceRow}>
                            <span className={css.credDeviceCode}>{oauth.userCode ?? ''}</span>
                            <a className={css.credLink} href={oauth.verificationUri} target="_blank" rel="noreferrer">
                              {oauth.verificationUri}
                            </a>
                          </div>
                          <span className={css.credDeviceHint}>{t('cred.deviceHint')}</span>
                          <span className={css.credDeviceWaiting}>{t('cred.deviceWaiting')}</span>
                        </div>
                      )
                      : null}
                  </div>
                )}
              <div className={css.formError}>{formError ?? ''}</div>
            </div>
            <div className={css.credFooter}>
              <Button size="sm" variant="outline" onClick={closeEditor}>{t('cancel')}</Button>
              {/* A browser sign-in stores its own token, so there is nothing
                * for a 保存 button to carry in that mode. */}
              {authMode === 'token'
                ? (
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                    {busy ? t('cred.saving') : t('cred.save')}
                  </Button>
                )
                : null}
            </div>
          </>
        )
        : null}
    </Modal>
  )
}
