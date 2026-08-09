import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { isMainWindow, readPortConfig, resolveGetStore } from '../src/poi.ts'

describe('isMainWindow', () => {
  test('is true only when poi marks the window as main', () => {
    assert.equal(isMainWindow({ isMain: true }), true)
  })

  test('is false in a plugin window, where the flag is absent', () => {
    assert.equal(isMainWindow({}), false)
  })

  test('is false when the flag is explicitly false', () => {
    assert.equal(isMainWindow({ isMain: false }), false)
  })

  test('is false for a missing window', () => {
    assert.equal(isMainWindow(undefined), false)
  })

  test('does not treat a truthy non-boolean as main', () => {
    assert.equal(isMainWindow({ isMain: 'yes' }), false)
  })
})

describe('resolveGetStore', () => {
  test('returns poi’s getStore when present', () => {
    const getStore = () => ({ info: {} })
    assert.equal(resolveGetStore({ getStore }), getStore)
  })

  test('throws a clear error when poi did not install getStore', () => {
    assert.throws(() => resolveGetStore({}), /getStore/)
  })

  test('throws when getStore is not callable', () => {
    assert.throws(() => resolveGetStore({ getStore: 'nope' }), /getStore/)
  })
})

describe('readPortConfig', () => {
  test('reads the configured port', () => {
    const window = { config: { get: () => 20000 } }
    assert.equal(readPortConfig(window, 'plugin.mcp.port', 12450), 20000)
  })

  test('passes the key and fallback through to poi', () => {
    const seen: unknown[] = []
    const window = {
      config: {
        get: (path: string, fallback: number) => {
          seen.push(path, fallback)
          return fallback
        },
      },
    }
    readPortConfig(window, 'plugin.mcp.port', 12450)
    assert.deepEqual(seen, ['plugin.mcp.port', 12450])
  })

  test('falls back to the default when poi has no config object', () => {
    assert.equal(readPortConfig({}, 'plugin.mcp.port', 12450), 12450)
  })

  test('falls back when config.get is missing', () => {
    assert.equal(readPortConfig({ config: {} }, 'plugin.mcp.port', 12450), 12450)
  })

  test('falls back when config.get throws', () => {
    const window = {
      config: {
        get: () => {
          throw new Error('config exploded')
        },
      },
    }
    assert.equal(readPortConfig(window, 'plugin.mcp.port', 12450), 12450)
  })

  test('falls back when the configured value is not a usable port', () => {
    const cases = ['20000', 0, -1, 70000, 1.5, null]
    for (const value of cases) {
      const window = { config: { get: () => value } }
      assert.equal(
        readPortConfig(window, 'plugin.mcp.port', 12450),
        12450,
        `expected fallback for ${JSON.stringify(value)}`,
      )
    }
  })
})
