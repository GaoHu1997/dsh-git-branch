/**
 * CnAcceleratePopover: the 国内加速 popover under the topbar button.
 *
 * This is the SHORTCUT surface of the same staged form the settings card row
 * edits ({@link ../accel-form}): enable switch + mirror URL stage together
 * and commit together on 保存. Closing the popover — Esc, outside click, 取消
 * — discards the staged edits through the owner's close handler, so an
 * abandoned draft can never land half-written.
 *
 * Layout follows docs/design/cn-accelerate.md §2.2: title + switch → security
 * hint → URL field with 恢复默认 → error line → footer.
 *
 * @module git-worktree/client/panel/CnAcceleratePopover
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { requestNetworkProbe } from '../api.ts'
import type { AccelFace } from '../accel-form.ts'
import type { NetworkChannelId, NetworkProbeResult } from '../../wire.ts'
import type { GitPanelTranslator } from '../panel-types.ts'
import css from '../GitHistoryPanel.module.css'

/** What the topbar button hands over: the shared accel form, the toast queue,
 * and the close path (which also discards the staged edits). */
export interface CnAcceleratePopoverProps {
  accel: AccelFace
  t: GitPanelTranslator
  pushToast: (text: string, tone: 'success' | 'error') => void
  /** Repository directory the probe runs against; undefined disables probing. */
  cwd: string | undefined
  onClose: () => void
}

/** Channel id → its display name; the probe rows stay in host order. */
const CHANNEL_LABELS: Record<NetworkChannelId, (t: GitPanelTranslator) => string> = {
  direct: t => t('accel.channel.direct'),
  proxy: t => t('accel.channel.proxy'),
  ip: t => t('accel.channel.ip'),
}

export function CnAcceleratePopover(props: CnAcceleratePopoverProps): JSX.Element {
  const { accel, t, pushToast, cwd, onClose } = props
  const [probe, setProbe] = useState<NetworkProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const state = useSyncExternalStore(accel.store.subscribe, accel.store.getSnapshot)

  // Esc or a click outside the popover closes it (the owner discards the
  // staged edits on close).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose])

  const locked = state.saving || !state.writable
  const onSave = useCallback(() => {
    if (state.saving || state.urlError !== null || state.proxyError !== null || !state.writable) return
    void (async () => {
      await accel.saveAccel()
      const after = accel.store.getSnapshot()
      if (after.failed) {
        pushToast(t('accel.saveFailed'), 'error')
        return
      }
      pushToast(after.enabled ? t('accel.savedOn', { url: after.urlText }) : t('accel.savedOff'), 'success')
      onClose()
    })()
  }, [accel, onClose, pushToast, state.saving, state.urlError, state.writable, t])

  // Probe is a READ-ONLY diagnostic: it never saves, and a dead endpoint is
  // reported per channel instead of as one toast (0043).
  const onProbe = useCallback(() => {
    if (cwd === undefined || probing) return
    setProbing(true)
    setProbeError(null)
    void (async () => {
      const result = await requestNetworkProbe(cwd)
      setProbing(false)
      if (!result.ok) {
        setProbe(null)
        setProbeError(result.error)
        return
      }
      setProbe({
        url: result.url,
        channels: result.channels,
        ...(result.systemProxy === undefined ? {} : { systemProxy: result.systemProxy }),
      })
    })()
  }, [cwd, probing])

  return (
    <div className={css.cnPop} ref={rootRef} role="dialog" aria-label={t('panel.cnAccelerate')}>
      <div className={css.cnPopHead}>
        <span className={css.cnPopTitle}>{t('panel.cnAccelerate')}</span>
        <label className={css.cnSwitchRow}>
          <span>{t('accel.enable')}</span>
          <input
            type="checkbox"
            className={css.cnSwitch}
            checked={state.enabled}
            disabled={locked}
            onChange={event => accel.setAccelEnabled(event.target.checked)}
          />
        </label>
      </div>
      <p className={css.cnHint}>{t('accel.hint')}</p>
      <div className={css.cnFieldHead}>
        <span className={css.cnFieldLabel}>{t('accel.urlLabel')}</span>
        <button
          type="button"
          className={css.cnLink}
          disabled={locked}
          onClick={() => accel.restoreAccelDefault()}
        >
          {t('accel.restoreDefault')}
        </button>
      </div>
      <input
        type="text"
        className={state.urlError !== null ? css.cnInputBad : css.cnInput}
        value={state.urlText}
        spellCheck={false}
        disabled={locked}
        aria-invalid={state.urlError !== null}
        onChange={event => accel.editAccelUrl(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') onSave() }}
      />
      {state.urlError !== null
        ? <div className={css.cnError}>{state.urlError === 'empty' ? t('accel.urlEmpty') : t('accel.urlInvalid')}</div>
        : null}
      <div className={css.cnFieldHead}>
        <span className={css.cnFieldLabel}>{t('accel.proxyLabel')}</span>
        <button
          type="button"
          className={css.cnLink}
          disabled={locked || cwd === undefined || probing}
          onClick={onProbe}
        >
          {probing ? t('accel.probing') : t('accel.probe')}
        </button>
      </div>
      <input
        type="text"
        className={state.proxyError !== null ? css.cnInputBad : css.cnInput}
        value={state.proxyText}
        spellCheck={false}
        disabled={locked}
        placeholder="http://127.0.0.1:7890"
        aria-invalid={state.proxyError !== null}
        onChange={event => accel.editNetworkProxy(event.target.value)}
      />
      {state.proxyError !== null
        ? <div className={css.cnError}>{t('accel.proxyInvalid')}</div>
        : null}
      {probe !== null
        ? (
          <div className={css.cnHint}>
            {probe.channels.map(channel => (
              <div key={channel.channel}>
                {channel.ok ? '\u2713 ' : '\u2717 '}
                {CHANNEL_LABELS[channel.channel](t)}
                {` \u00b7 ${String(channel.elapsedMs)} ms`}
                {channel.detail === undefined ? null : ` \u00b7 ${channel.detail}`}
              </div>
            ))}
          </div>
        )
        : null}
      {probeError !== null ? <div className={css.cnError}>{probeError}</div> : null}
      <div className={css.cnFooter}>
        <button type="button" className={css.cnGhost} onClick={onClose}>{t('cancel')}</button>
        <button
          type="button"
          className={css.cnSave}
          disabled={state.saving || state.urlError !== null || state.proxyError !== null || !state.writable}
          onClick={onSave}
        >
          {t('cardSave')}
        </button>
      </div>
    </div>
  )
}
