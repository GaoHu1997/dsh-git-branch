/**
 * Form over the cn-accelerate unit of the `dsh-git-branch` Host entry.
 *
 * The popover (git panel) and the settings card row are two views of THIS
 * one form: same staged edits, same validation, same save — the popover is a
 * shortcut, not a second configuration. Both fields are staged and commit
 * together on save (「一次生效」): flipping the switch must not apply a
 * mirror URL the user has not confirmed, and a half-written pair (switch on,
 * prefix still the old one) is a rewrite the user never asked for.
 *
 * Self-contained on purpose, like {@link ./card-form}: the client
 * bundle-purity rule forbids value imports across plugins.
 *
 * @module git-worktree/client/accel-form
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ACCEL_DEFAULT_URL, accelerateUrlError, normalizeAccelerateUrl, proxyUrlError, type AccelerateUrlIssue } from '../normalize.ts'
import type { SectionValue } from './card-form.ts'

/** The fields this form edits. */
export const ACCEL_ENABLED_FIELD = 'cnAccelerate'
export const ACCEL_URL_FIELD = 'cnAccelerateUrl'
/** The proxy channel's config key (0043); blank = no proxy channel. */
export const NETWORK_PROXY_FIELD = 'networkProxy'

/**
 * Minimal observable snapshot source, the same stable-reference discipline
 * as the card store.
 */
export interface AccelStore {
  /** @returns the current snapshot (stable reference until the next change). */
  getSnapshot(): AccelState
  /** @param listener - invoked after each snapshot change. @returns the disposer. */
  subscribe(listener: () => void): () => void
  /** @param next - the new snapshot; replaces the reference only on a real change. */
  set(next: AccelState): void
}

/** What the popover and the card row render for the cn-accelerate unit. */
export interface AccelState {
  /** False while the namespace is not served to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Resolved enable switch (user layer over the default off). */
  enabled: boolean
  /** The accelerate URL as TEXT: the effective value, or the live draft. */
  urlText: string
  /** Whether the form holds an edit that a save would write. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
  /** Why the URL text (draft or effective) is not usable yet; null = fine. */
  urlError: AccelerateUrlIssue | null
  /** The proxy URL as TEXT (effective value or live draft); blank = no proxy. */
  proxyText: string
  /** Why the proxy text is not usable yet; null = fine (blank included). */
  proxyError: string | null
}

/**
 * The form actions both surfaces inject. Names carry the `Accel` prefix so
 * spreading them beside the card's {@link CardActions} cannot collide.
 */
export interface AccelActions {
  /** Stage the enable switch (takes effect with saveAccel). */
  setAccelEnabled: (value: boolean) => void
  /** Stage draft text for the accelerate URL (validated on save). */
  editAccelUrl: (text: string) => void
  /** Stage draft text for the proxy URL (validated on save; blank = none). */
  editNetworkProxy: (text: string) => void
  /** Fill the URL draft with the shipped default (a stage, not a write). */
  restoreAccelDefault: () => void
  /** Write the switch AND the normalized URL together, then re-seed.
   * Returns the save's promise (still assignable to void-returning slots) so
   * the popover and tests can await settlement and read `failed`. */
  saveAccel: () => Promise<void>
  /** Drop the staged edits (popover close/取消). */
  discardAccel: () => void
}

/** Store plus bound actions — what a consumer surface receives. */
export interface AccelFace extends AccelActions {
  store: AccelStore
}

/**
 * Stages the cn-accelerate edits over the `dsh-git-branch` Host entry.
 *
 * Publishes through a snapshot store like {@link CardForm}: the consumer
 * reads through a snapshot selector while the scope and the local drafts
 * change underneath; every projection is rebuilt from the two together.
 */
export class AccelForm {
  private snapshotValue: AccelState
  private readonly listeners = new Set<() => void>()
  private enabledDraft: boolean | undefined
  private urlDraft: string | undefined
  private proxyDraft: string | undefined
  private saving = false
  private failed = false

  /**
   * @param scope - the bound configuration form for the `dsh-git-branch` Host entry.
   */
  constructor(private readonly scope: ConfigForm<SectionValue>) {
    this.snapshotValue = this.project()
    scope.subscribe(() => { this.publish() })
  }

  /** @returns the store a consumer reads through its bound selector. */
  bind(): AccelStore {
    return {
      getSnapshot: () => this.snapshotValue,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      set: (next) => { this.store(next) },
    }
  }

  /** @returns the stage, restore, save, and discard actions bound to this form. */
  actions(): AccelActions {
    return {
      setAccelEnabled: (value) => {
        this.enabledDraft = value
        this.failed = false
        this.publish()
      },
      editAccelUrl: (text) => {
        this.urlDraft = text
        this.failed = false
        this.publish()
      },
      editNetworkProxy: (text) => {
        this.proxyDraft = text
        this.failed = false
        this.publish()
      },
      restoreAccelDefault: () => {
        this.urlDraft = ACCEL_DEFAULT_URL
        this.failed = false
        this.publish()
      },
      // Returns the save's promise so callers that care — the popover's
      // toast-on-settle, tests — can await it.
      saveAccel: () => this.save(),
      discardAccel: () => {
        if (this.enabledDraft === undefined && this.urlDraft === undefined && this.proxyDraft === undefined && !this.failed) return
        this.enabledDraft = undefined
        this.urlDraft = undefined
        this.proxyDraft = undefined
        this.failed = false
        this.publish()
      },
    }
  }

  /** The URL as the user sees it: the live draft, else the stored value over
   * the shipped default. */
  private effectiveUrlText(): string {
    const value = this.scope.getSnapshot().value?.[ACCEL_URL_FIELD]
    return this.urlDraft ?? (value ?? ACCEL_DEFAULT_URL)
  }

  /** The proxy as the user sees it: the live draft, else the stored value. */
  private effectiveProxyText(): string {
    const value = this.scope.getSnapshot().value?.[NETWORK_PROXY_FIELD]
    return this.proxyDraft ?? (typeof value === 'string' ? value : '')
  }

  /**
   * Write the switch and the normalized URL TOGETHER, then re-seed from what
   * the Host accepted. The URL is validated first — an unusable draft blocks
   * the save (and the surfaces disable the button on the same error), so the
   * switch can never land alone against a mirror the user has not confirmed.
   * A save that did not land keeps its drafts so the user can correct them.
   */
  private async save(): Promise<void> {
    if ((this.enabledDraft === undefined && this.urlDraft === undefined && this.proxyDraft === undefined) || this.saving) return
    const urlText = this.effectiveUrlText()
    if (accelerateUrlError(urlText) !== undefined) return
    const proxyText = this.effectiveProxyText().trim()
    if (proxyText !== '' && proxyUrlError(proxyText) !== undefined) return
    const intendedEnabled = this.enabledDraft ?? (this.scope.getSnapshot().value?.[ACCEL_ENABLED_FIELD] ?? false)
    const intendedUrl = normalizeAccelerateUrl(urlText)
    // Only a staged proxy is written: a switch-only save must not rewrite an
    // untouched key (and must keep working when the host rejects unknown keys).
    const writeProxy = this.proxyDraft !== undefined
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      await this.scope.set(ACCEL_ENABLED_FIELD, intendedEnabled)
      await this.scope.set(ACCEL_URL_FIELD, intendedUrl)
      if (writeProxy) await this.scope.set(NETWORK_PROXY_FIELD, proxyText)
      // The Host is the only authority on acceptance: both keys must read
      // back as written, or the pair did not land as staged.
      const user = this.userLayer()
      if (user?.[ACCEL_ENABLED_FIELD] !== intendedEnabled || user?.[ACCEL_URL_FIELD] !== intendedUrl || (writeProxy && (user?.[NETWORK_PROXY_FIELD] ?? '') !== proxyText)) {
        landed = false
      }
    } catch (_settingsWriteFailure) {
      landed = false
    }
    if (landed) {
      this.enabledDraft = undefined
      this.urlDraft = undefined
      this.proxyDraft = undefined
    }
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /** The raw user layer narrowed to a record; the wire answer is `unknown`. */
  private userLayer(): Record<string, unknown> | undefined {
    const user = this.scope.getSnapshot().user
    return typeof user === 'object' && user !== null ? user as Record<string, unknown> : undefined
  }

  private project(): AccelState {
    const snapshot = this.scope.getSnapshot()
    const storedEnabled = snapshot.value?.[ACCEL_ENABLED_FIELD] ?? false
    const storedUrl = snapshot.value?.[ACCEL_URL_FIELD] ?? ACCEL_DEFAULT_URL
    const urlText = this.effectiveUrlText()
    const storedProxy = typeof snapshot.value?.[NETWORK_PROXY_FIELD] === 'string' ? snapshot.value[NETWORK_PROXY_FIELD] as string : ''
    const proxyText = this.effectiveProxyText()
    const enabledDirty = this.enabledDraft !== undefined && this.enabledDraft !== storedEnabled
    const urlDirty = this.urlDraft !== undefined && this.urlDraft !== storedUrl
    const proxyDirty = this.proxyDraft !== undefined && this.proxyDraft !== storedProxy
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      enabled: this.enabledDraft ?? storedEnabled,
      urlText,
      dirty: enabledDirty || urlDirty || proxyDirty,
      saving: this.saving,
      failed: this.failed,
      urlError: accelerateUrlError(urlText) ?? null,
      proxyText,
      proxyError: proxyText.trim() === '' ? null : (proxyUrlError(proxyText.trim()) ?? null),
    }
  }

  /** Replace the snapshot reference and notify, only when the fact moved. */
  private store(next: AccelState): void {
    if (next === this.snapshotValue) return
    this.snapshotValue = next
    for (const listener of this.listeners) listener()
  }

  private publish(): void {
    this.store(this.project())
  }
}
