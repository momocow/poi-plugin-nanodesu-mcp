import React from 'react'

import { translate } from './i18n.ts'
import type { ServerStatus } from './server.ts'

const t = (str: string): string => translate(typeof window === 'undefined' ? undefined : window, str)

/**
 * The panel exists so a failed bind is visible. Without it the server would
 * simply not be there, with nothing in the UI to say why.
 *
 * Built with createElement rather than JSX, and as a class component rather
 * than hooks, so it stays correct regardless of which React version poi
 * supplies at runtime.
 */

let current: ServerStatus = { state: 'stopped', requestCount: 0 }
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

const row = (label: string, value: string) =>
  React.createElement(
    'div',
    { style: { display: 'flex', gap: 8, padding: '2px 0' } },
    React.createElement('span', { style: { opacity: 0.7, minWidth: 110 } }, label),
    React.createElement('span', null, value),
  )

export class StatusPanel extends React.Component<
  Record<string, unknown>,
  { status: ServerStatus }
> {
  constructor(props: Record<string, unknown>) {
    super(props)
    this.state = { status: current }
  }

  private onChange = (status: ServerStatus) => this.setState({ status })

  componentDidMount(): void {
    listeners.add(this.onChange)
    this.setState({ status: current })
  }

  componentWillUnmount(): void {
    listeners.delete(this.onChange)
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
      row(t('Endpoint'), endpoint),
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
      status.state === 'listening'
        ? React.createElement(
            'div',
            { style: { marginTop: 16, opacity: 0.7 } },
            React.createElement('div', null, t('Connect an agent with:')),
            React.createElement(
              'code',
              { style: { userSelect: 'text' } },
              `claude mcp add poi --transport http ${endpoint}`,
            ),
          )
        : null,
    )
  }
}
