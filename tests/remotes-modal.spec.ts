/**
 * RemotesModal's interaction shape: the list is the dialog's default view and
 * the editor only enters the DOM once the header's 「+」 asks for it — the
 * same collapsed-editor pattern the credential dialog uses.
 *
 * The dialog renders through the host's `Modal`, which ends in
 * `createPortal(..., document.body)`; the suite runs in a node environment, so
 * the host primitives are replaced with inert stand-ins that still emit their
 * children and footer. That keeps the assertion on this component's own JSX
 * (what is conditional on `editorOpen`) rather than on portal plumbing.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: (props: { children?: ReactNode; footer?: ReactNode }) => createElement('div', { 'data-modal': 'open' }, props.children, props.footer),
  Button: (props: { children?: ReactNode; variant?: string; disabled?: boolean }) => createElement(
    'button',
    { 'data-variant': props.variant, 'disabled': props.disabled },
    props.children,
  ),
}))

const { RemotesModal } = await import('../src/client/panel/RemotesModal.tsx')

/** The dialog's props with no-op callbacks; `t` returns the key so every
 * assertion reads against stable, locale-independent text. */
const PROPS = {
  repoPath: '/repo',
  t: (key: string) => key,
  pushToast: () => {},
  onClose: () => {},
}

/** Markup of the dialog in its default (list, no editor) state. */
function renderClosed(): string {
  return renderToStaticMarkup(createElement(RemotesModal, PROPS))
}

describe('RemotesModal collapsed editor', () => {
  it('renders the add button but no editor fields until it is opened', () => {
    const html = renderClosed()
    expect(html).toContain('aria-label="remotes.add"')
    expect(html).toContain('aria-expanded="false"')
    // Every editor field id is absent: the form is not merely hidden, it is
    // not rendered at all.
    expect(html).not.toContain('git-remote-name')
    expect(html).not.toContain('git-remote-url')
    expect(html).not.toContain('remotes.nameLabel')
    expect(html).not.toContain('remotes.save')
  })

  it('carries the credential editor\'s close/cancel arrangement', () => {
    const html = renderClosed()
    // The modal's own footer keeps a single 关闭 action, as the credential
    // dialog does; 取消 belongs to the editor row and is absent until opened.
    expect(html).toContain('>close</button>')
    expect(html).not.toContain('>cancel</button>')
  })
})
