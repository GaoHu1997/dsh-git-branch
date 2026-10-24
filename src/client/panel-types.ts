/**
 * Shared types for the Git panel's components (type-only, zero runtime).
 * The entry card lives in the dsh-better-sidebar plugin's right sidebar:
 * that plugin publishes `ctx.betterSidebar`, a registry other plugins use
 * to contribute sidebar tabs. better-sidebar is an OPTIONAL plugin, so the
 * shapes it owns are mirrored here (the dsh-token-total convention for
 * host contracts) and the registration waits for the service through
 * `ctx.inject(['betterSidebar'])` — absent plugin, absent card, and the
 * rest of this plugin keeps working.
 */

import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** The bound translator seat shared by the panel components (the
 * git-worktree namespace's dictionary union). */
export type GitPanelTranslator = TranslateNS<'git-worktree'>

/** The model selection the AI message generator borrows (mirror of the
 * session-controller's ModelSelection projection). */
export interface SessionModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One session scope as better-sidebar threads it through every tab call
 * (mirror of its SessionScope: the conversation id plus its cwd when known). */
export interface SidebarTabScope {
  readonly sessionId: string
  readonly cwd?: string
  /** Selected Git repository when cwd is a workspace container. */
  readonly repoRoot?: string
}

/** The host-context members the tab component reads (mirror: the session
 * list store, for the model-selection projection and the cwd fallback). */
export interface PanelHostContext {
  readonly sessions: {
    readonly list: {
      getSnapshot(): {
        readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
        readonly projectionsBySession: Readonly<Record<string, {
          readonly values: {
            readonly modelSelection?: {
              readonly next?: SessionModelSelection | null
              readonly lastUsed?: SessionModelSelection | null
            }
          }
        }>>
      }
      subscribe(listener: () => void): () => void
    }
  }
}

/** Narrow mirror of the better-sidebar tab registration: only the
 * descriptor members this plugin passes and the component props it reads. */
export interface BetterSidebarService {
  registerTab(descriptor: {
    /** Unique id; also the opened tab's `type` value. */
    id: string
    title: string | (() => string)
    description?: string | (() => string)
    icon?: ReactNode | ((size: number) => ReactNode)
    /** + menu sort order (ascending); default 100. */
    order?: number
    /** Single-instance sugar: opening focuses the existing tab. */
    single?: boolean
    component: (props: {
      ctx: PanelHostContext
      scope: SidebarTabScope
      tab: { readonly id: string }
      visible: boolean
    }) => ReactNode
  }): () => void
}
