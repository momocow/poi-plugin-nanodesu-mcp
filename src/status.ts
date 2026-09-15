import React from 'react'

import { translate } from './i18n.ts'
import { readStringConfig, writeStringConfig } from './poi.ts'
import type { ServerStatus } from './server.ts'

const poiWindow = (): unknown => (typeof window === 'undefined' ? undefined : window)

const t = (str: string): string => translate(typeof window === 'undefined' ? undefined : window, str)

/**
 * The panel exists so a failed bind is visible. Without it the server would
 * simply not be there, with nothing in the UI to say why.
 *
 * Built with createElement rather than JSX, and as a class component rather
 * than hooks, so it stays correct regardless of which React version poi
 * supplies at runtime.
 */

let current: ServerStatus = { state: 'stopped', requestCount: 0, recent: [] }
const listeners = new Set<(status: ServerStatus) => void>()

export const setStatus = (status: ServerStatus): void => {
  current = status
  for (const listener of listeners) {
    listener(status)
  }
}

export const getStatus = (): ServerStatus => current

const COLORS: Record<ServerStatus['state'], string> = {
  listening: '#3dcc91',
  stopped: '#a7b6c2',
  error: '#ff7373',
}

const LABELS: Record<ServerStatus['state'], string> = {
  listening: 'Listening',
  stopped: 'Stopped',
  error: 'Error',
}

const SCOPES = ['user', 'project', 'local'] as const

type Scope = (typeof SCOPES)[number]

/** Which button last copied, so only that one says so. */
type CopyTarget = 'command' | 'endpoint'

const SCOPE_LABELS: Record<Scope, string> = {
  user: 'User scope',
  project: 'Project scope',
  local: 'Local scope',
}

/** Kept in poi's config so the choice survives a panel remount or a restart. */
export const SCOPE_CONFIG_KEY = 'plugin.mcp.scope'

const DEFAULT_SCOPE: Scope = 'local'

const readScope = (window: unknown): Scope => {
  const stored = readStringConfig(window, SCOPE_CONFIG_KEY)
  return SCOPES.find((scope) => scope === stored) ?? DEFAULT_SCOPE
}

const buildCommand = (scope: Scope, endpoint: string): string =>
  `claude mcp add poi --scope ${scope} --transport http ${endpoint}`

const row = (label: string, value: string, trailing?: unknown) =>
  React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' } },
    React.createElement('span', { style: { opacity: 0.7, minWidth: 110 } }, label),
    React.createElement('span', null, value),
    trailing ?? null,
  )

/** A glyph rather than an icon font, so nothing depends on poi's icon set. */
const ICON_BUTTON = {
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
}

/**
 * Clipboard API where there is one; a renderer without it (or outside a secure
 * context) falls back to execCommand, which copies a selection rather than a
 * string — hence the throwaway textarea.
 */
const copyText = (text: string): void => {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard !== undefined) {
    void clipboard.writeText(text)
    return
  }

  const doc = globalThis.document
  if (doc === undefined) {
    return
  }
  const scratch = doc.createElement('textarea')
  scratch.value = text
  scratch.style.position = 'fixed'
  scratch.style.opacity = '0'
  doc.body.appendChild(scratch)
  scratch.select()
  doc.execCommand('copy')
  scratch.remove()
}

export class StatusPanel extends React.Component<
  Record<string, unknown>,
  { status: ServerStatus; scope: Scope; edited: string | null; copied: CopyTarget | null }
> {
  private copiedTimer: ReturnType<typeof setTimeout> | undefined

  constructor(props: Record<string, unknown>) {
    super(props)
    this.state = { status: current, scope: readScope(poiWindow()), edited: null, copied: null }
  }

  private onChange = (status: ServerStatus) => this.setState({ status })

  componentDidMount(): void {
    listeners.add(this.onChange)
    this.setState({ status: current })
  }

  componentWillUnmount(): void {
    listeners.delete(this.onChange)
    clearTimeout(this.copiedTimer)
  }

  /**
   * Picking a scope rewrites just the `--scope` argument, so the rest of an
   * edited command survives. A command the user has stripped of `--scope` is
   * left alone.
   */
  private selectScope = (scope: Scope) => {
    const { edited } = this.state
    writeStringConfig(poiWindow(), SCOPE_CONFIG_KEY, scope)
    this.setState({
      scope,
      edited: edited === null ? null : edited.replace(/--scope(\s+|=)\S+/, `--scope$1${scope}`),
    })
  }

  /** A shell command is one line; the textarea's newlines are collapsed away. */
  private editCommand = (event: { target: { value: string } }) =>
    this.setState({ edited: event.target.value.replace(/\s*\n\s*/g, ' ') })

  private copy = (target: CopyTarget, text: string) => {
    copyText(text)
    clearTimeout(this.copiedTimer)
    this.copiedTimer = setTimeout(() => this.setState({ copied: null }), 1500)
    this.setState({ copied: target })
  }

  private copyButton = (target: CopyTarget, text: string, icon = false) => {
    const done = this.state.copied === target
    const label = done ? t('Copied') : t('Copy')

    return React.createElement(
      'button',
      {
        onClick: () => this.copy(target, text),
        // The icon form has no text, so the label has to reach the tooltip and
        // the accessibility tree instead.
        title: label,
        'aria-label': label,
        style: icon ? { ...ICON_BUTTON, opacity: done ? 1 : 0.7 } : { padding: '4px 10px' },
      },
      icon ? (done ? '✓' : '⧉') : label,
    )
  }

  private renderConnect(endpoint: string): unknown {
    const { scope, edited } = this.state
    const command = edited ?? buildCommand(scope, endpoint)

    return React.createElement(
      'div',
      { style: { marginTop: 16 } },
      React.createElement(
        'div',
        { style: { opacity: 0.7, marginBottom: 6 } },
        t('Connect an agent with:'),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 12, marginBottom: 6 } },
        ...SCOPES.map((value) =>
          React.createElement(
            'label',
            {
              key: value,
              style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' },
            },
            React.createElement('input', {
              type: 'radio',
              name: 'poi-nanodesu-mcp-scope',
              value,
              checked: scope === value,
              onChange: () => this.selectScope(value),
            }),
            t(SCOPE_LABELS[value]),
          ),
        ),
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
        // A textarea rather than an input so the whole command stays visible:
        // it wraps instead of scrolling the endpoint out of sight.
        React.createElement('textarea', {
          rows: 2,
          value: command,
          onChange: this.editCommand,
          style: {
            flex: 1,
            minWidth: 0,
            resize: 'vertical',
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.4,
            padding: '4px 6px',
          },
        }),
        this.copyButton('command', command),
      ),
    )
  }

  private renderRecent(): unknown {
    const { recent } = this.state.status

    return React.createElement(
      'div',
      { style: { marginTop: 16 } },
      React.createElement(
        'div',
        { style: { opacity: 0.7, marginBottom: 6 } },
        t('Recent requests'),
      ),
      recent.length === 0
        ? React.createElement('div', { style: { opacity: 0.5 } }, t('none yet'))
        : React.createElement(
            'div',
            {
              style: {
                maxHeight: 180,
                overflowY: 'auto',
                fontFamily: 'monospace',
                fontSize: 12,
              },
            },
            ...recent.map((entry, index) =>
              React.createElement(
                'div',
                {
                  key: `${entry.at}-${index}`,
                  style: { display: 'flex', gap: 8, padding: '1px 0' },
                },
                React.createElement(
                  'span',
                  { style: { opacity: 0.6 } },
                  new Date(entry.at).toLocaleTimeString(),
                ),
                React.createElement('span', null, entry.tool ?? entry.method),
                entry.detail === undefined
                  ? null
                  : React.createElement('span', { style: { opacity: 0.6 } }, entry.detail),
              ),
            ),
          ),
    )
  }

  render(): unknown {
    const { status } = this.state
    const endpoint =
      status.port === undefined ? '—' : `http://127.0.0.1:${status.port}/mcp`
    const lastRequest =
      status.lastRequestAt === undefined
        ? t('none yet')
        : new Date(status.lastRequestAt).toLocaleTimeString()

    return React.createElement(
      'div',
      { style: { padding: 16, fontFamily: 'system-ui, sans-serif', fontSize: 13 } },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
        React.createElement('span', {
          style: {
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: COLORS[status.state],
            display: 'inline-block',
          },
        }),
        React.createElement(
          'strong',
          { style: { fontSize: 15 } },
          `${t('MCP server')} — ${t(LABELS[status.state])}`,
        ),
      ),
      row(
        t('Endpoint'),
        endpoint,
        status.state === 'listening' ? this.copyButton('endpoint', endpoint, true) : null,
      ),
      row(t('Requests'), String(status.requestCount)),
      row(t('Last request'), lastRequest),
      status.error === undefined
        ? null
        : React.createElement(
            'div',
            {
              style: {
                marginTop: 12,
                padding: 8,
                borderRadius: 4,
                background: 'rgba(255, 115, 115, 0.15)',
                color: '#ff7373',
              },
            },
            status.error,
          ),
      status.state === 'listening' ? this.renderConnect(endpoint) : null,
      this.renderRecent(),
    )
  }
}
