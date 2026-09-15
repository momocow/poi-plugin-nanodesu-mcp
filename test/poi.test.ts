import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  isMainWindow,
  readIntConfig,
  readPortConfig,
  readStringConfig,
  resolveGetStore,
  writeConfig,
} from '../src/poi.ts'

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
    assert.equal(readPortConfig(window, 'plugin.poi_nanodesu_mcp.port', 12450), 20000)
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
    readPortConfig(window, 'plugin.poi_nanodesu_mcp.port', 12450)
    assert.deepEqual(seen, ['plugin.poi_nanodesu_mcp.port', 12450])
  })

  test('falls back to the default when poi has no config object', () => {
    assert.equal(readPortConfig({}, 'plugin.poi_nanodesu_mcp.port', 12450), 12450)
  })

  test('falls back when config.get is missing', () => {
    assert.equal(readPortConfig({ config: {} }, 'plugin.poi_nanodesu_mcp.port', 12450), 12450)
  })

  test('falls back when config.get throws', () => {
    const window = {
      config: {
        get: () => {
          throw new Error('config exploded')
        },
      },
    }
    assert.equal(readPortConfig(window, 'plugin.poi_nanodesu_mcp.port', 12450), 12450)
  })

  test('falls back when the configured value is not a usable port', () => {
    const cases = ['20000', 0, -1, 70000, 1.5, null]
    for (const value of cases) {
      const window = { config: { get: () => value } }
      assert.equal(
        readPortConfig(window, 'plugin.poi_nanodesu_mcp.port', 12450),
        12450,
        `expected fallback for ${JSON.stringify(value)}`,
      )
    }
  })
})

describe('readStringConfig', () => {
  test('reads the configured string', () => {
    const window = { config: { get: () => 'project' } }
    assert.equal(readStringConfig(window, 'plugin.poi_nanodesu_mcp.scope'), 'project')
  })

  test('passes the key through to poi', () => {
    const seen: unknown[] = []
    const window = { config: { get: (path: string) => seen.push(path) && undefined } }
    readStringConfig(window, 'plugin.poi_nanodesu_mcp.scope')
    assert.deepEqual(seen, ['plugin.poi_nanodesu_mcp.scope'])
  })

  test('is undefined when poi has no config object', () => {
    assert.equal(readStringConfig({}, 'plugin.poi_nanodesu_mcp.scope'), undefined)
  })

  test('is undefined when config.get throws', () => {
    const window = {
      config: {
        get: () => {
          throw new Error('config exploded')
        },
      },
    }
    assert.equal(readStringConfig(window, 'plugin.poi_nanodesu_mcp.scope'), undefined)
  })

  test('is undefined for a non-string or empty value', () => {
    for (const value of [42, null, '', {}]) {
      const window = { config: { get: () => value } }
      assert.equal(
        readStringConfig(window, 'plugin.poi_nanodesu_mcp.scope'),
        undefined,
        `expected undefined for ${JSON.stringify(value)}`,
      )
    }
  })
})

describe('writeConfig', () => {
  test('writes through to poi’s config', () => {
    const seen: unknown[] = []
    const window = { config: { set: (path: string, value: unknown) => seen.push(path, value) } }
    writeConfig(window, 'plugin.poi_nanodesu_mcp.scope', 'user')
    assert.deepEqual(seen, ['plugin.poi_nanodesu_mcp.scope', 'user'])
  })

  test('does nothing when poi has no config.set', () => {
    assert.doesNotThrow(() => writeConfig({ config: {} }, 'plugin.poi_nanodesu_mcp.scope', 'user'))
  })

  test('swallows a throwing config.set', () => {
    const window = {
      config: {
        set: () => {
          throw new Error('config exploded')
        },
      },
    }
    assert.doesNotThrow(() => writeConfig(window, 'plugin.poi_nanodesu_mcp.scope', 'user'))
  })
})

describe('readIntConfig', () => {
  const bounds = { fallback: 100, min: 1, max: 100 }

  test('reads a value inside the range', () => {
    const window = { config: { get: () => 25 } }
    assert.equal(readIntConfig(window, 'plugin.poi_nanodesu_mcp.recentRequests', bounds), 25)
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
    readIntConfig(window, 'plugin.poi_nanodesu_mcp.recentRequests', bounds)
    assert.deepEqual(seen, ['plugin.poi_nanodesu_mcp.recentRequests', 100])
  })

  test('falls back for a value outside the range or not an integer', () => {
    for (const value of [0, -1, 101, 2.5, '25', null, undefined]) {
      const window = { config: { get: () => value } }
      assert.equal(
        readIntConfig(window, 'plugin.poi_nanodesu_mcp.recentRequests', bounds),
        100,
        `expected fallback for ${JSON.stringify(value)}`,
      )
    }
  })

  test('falls back when poi has no config or the read throws', () => {
    assert.equal(readIntConfig({}, 'plugin.poi_nanodesu_mcp.recentRequests', bounds), 100)
    const window = {
      config: {
        get: () => {
          throw new Error('config exploded')
        },
      },
    }
    assert.equal(readIntConfig(window, 'plugin.poi_nanodesu_mcp.recentRequests', bounds), 100)
  })
})
