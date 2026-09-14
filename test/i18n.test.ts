import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { NAMESPACE, translate } from '../src/i18n.ts'

describe('translate', () => {
  test('returns the source string unchanged when window is missing', () => {
    assert.equal(translate(undefined, 'Stopped'), 'Stopped')
  })

  test('returns the source string unchanged when poi has no translator for this plugin', () => {
    assert.equal(translate({}, 'Stopped'), 'Stopped')
  })

  test('delegates to poi’s namespaced translator when present', () => {
    const window = {
      i18n: {
        [NAMESPACE]: { __: (s: string) => `[${s}]` },
      },
    }
    assert.equal(translate(window, 'Stopped'), '[Stopped]')
  })

  test('ignores a non-callable translator', () => {
    const window = { i18n: { [NAMESPACE]: { __: 'nope' } } }
    assert.equal(translate(window, 'Stopped'), 'Stopped')
  })

  test('ignores translators registered under a different namespace', () => {
    const window = { i18n: { other_plugin: { __: (s: string) => `[${s}]` } } }
    assert.equal(translate(window, 'Stopped'), 'Stopped')
  })
})
