import React from 'react'

import { PORT_CONFIG_KEY, RECENT_CONFIG_KEY } from './config.ts'
import { translate } from './i18n.ts'
import { readIntConfig, writeConfig } from './poi.ts'
import { DEFAULT_RECENT_LIMIT } from './request-log.ts'
import { DEFAULT_PORT } from './server.ts'

/**
 * poi's settings page renders a plugin's own `settingsClass`; it does not
 * derive anything from config keys. Without this component these settings
 * would be reachable only by hand-editing poi's config.cson.
 *
 * Same constraints as src/status.ts: createElement and a class component, so
 * it works whichever React poi supplies.
 */

const t = (str: string): string => translate(typeof window === 'undefined' ? undefined : window, str)

const poiWindow = (): unknown => (typeof window === 'undefined' ? undefined : window)

type Field = {
  key: string
  label: string
  min: number
  /** Omitted where the setting has no ceiling. */
  max?: number
  fallback: number
}

const FIELDS: Field[] = [
  { key: PORT_CONFIG_KEY, label: 'Port', min: 1, max: 65535, fallback: DEFAULT_PORT },
  {
    key: RECENT_CONFIG_KEY,
    label: 'Recent requests kept',
    min: 1,
    fallback: DEFAULT_RECENT_LIMIT,
  },
]

const read = (field: Field): number =>
  readIntConfig(poiWindow(), field.key, {
    fallback: field.fallback,
    min: field.min,
    max: field.max ?? Number.MAX_SAFE_INTEGER,
  })

export class SettingsPanel extends React.Component<
  Record<string, unknown>,
  { values: Record<string, string> }
> {
  constructor(props: Record<string, unknown>) {
    super(props)
    this.state = {
      values: Object.fromEntries(FIELDS.map((field) => [field.key, String(read(field))])),
    }
  }

  /**
   * A half-typed value stays in the box without being written: the config
   * should never hold a number the server would refuse anyway.
   */
  private edit = (field: Field, text: string) => {
    this.setState({ values: { ...this.state.values, [field.key]: text } })

    const value = Number(text)
    if (Number.isInteger(value) && value >= field.min && value <= (field.max ?? Infinity)) {
      writeConfig(poiWindow(), field.key, value)
    }
  }

  render(): unknown {
    return React.createElement(
      'div',
      { style: { fontFamily: 'system-ui, sans-serif', fontSize: 13 } },
      ...FIELDS.map((field) =>
        React.createElement(
          'div',
          {
            key: field.key,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' },
          },
          React.createElement('span', { style: { opacity: 0.7, minWidth: 160 } }, t(field.label)),
          React.createElement('input', {
            type: 'number',
            min: field.min,
            max: field.max,
            value: this.state.values[field.key],
            onChange: (event: { target: { value: string } }) => this.edit(field, event.target.value),
            style: { width: 90, padding: '2px 6px' },
          }),
          React.createElement(
            'span',
            { style: { opacity: 0.5 } },
            field.max === undefined ? `≥ ${field.min}` : `${field.min}–${field.max}`,
          ),
        ),
      ),
      React.createElement(
        'div',
        { style: { marginTop: 8, opacity: 0.7 } },
        t('Takes effect the next time the plugin is loaded.'),
      ),
    )
  }
}
