import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { parseFieldPath, getByPath, resolveStorePath, readableRoots } from '../src/paths.ts'

describe('parseFieldPath', () => {
  test('splits a dotted path into segments', () => {
    assert.deepEqual(parseFieldPath('info.basic.api_nickname'), [
      'info',
      'basic',
      'api_nickname',
    ])
  })

  test('parses bracket indices as numbers', () => {
    assert.deepEqual(parseFieldPath('api_exp[0]'), ['api_exp', 0])
  })

  test('parses indices mixed with dotted segments', () => {
    assert.deepEqual(parseFieldPath('info.fleets[1].api_name'), [
      'info',
      'fleets',
      1,
      'api_name',
    ])
  })

  test('rejects an empty path', () => {
    assert.throws(() => parseFieldPath(''), /empty/i)
  })

  test('rejects a trailing dot', () => {
    assert.throws(() => parseFieldPath('info.'), /empty segment/i)
  })

  test('rejects an unclosed bracket', () => {
    assert.throws(() => parseFieldPath('api_exp[0'), /unclosed/i)
  })
})

describe('getByPath', () => {
  const value = {
    info: { basic: { api_nickname: 'x' }, fleets: [{ api_name: 'first' }] },
  }

  test('reads a nested value', () => {
    assert.equal(getByPath(value, ['info', 'basic', 'api_nickname']), 'x')
  })

  test('reads through an array index', () => {
    assert.equal(getByPath(value, ['info', 'fleets', 0, 'api_name']), 'first')
  })

  test('returns undefined for a missing key', () => {
    assert.equal(getByPath(value, ['info', 'nope']), undefined)
  })

  test('returns undefined rather than throwing when descending into a scalar', () => {
    assert.equal(getByPath(value, ['info', 'basic', 'api_nickname', 'deep']), undefined)
  })

  test('returns undefined when descending into null', () => {
    assert.equal(getByPath({ a: null }, ['a', 'b']), undefined)
  })
})

describe('resolveStorePath', () => {
  const store = {
    info: { basic: { api_nickname: 'Admiral' }, ships: { '1': { api_lv: 3 } } },
    const: { $ships: { '487': { api_name: '長鯨' } } },
    layout: { webview: { ref: {} } },
    config: { poi: {} },
  }

  test('resolves a path under an allowed root', () => {
    const result = resolveStorePath(store, 'info.basic')
    assert.deepEqual(result, { ok: true, value: { api_nickname: 'Admiral' } })
  })

  test('resolves an allowed root itself', () => {
    const result = resolveStorePath(store, 'const')
    assert.equal(result.ok, true)
  })

  test('denies a denied root by name', () => {
    const result = resolveStorePath(store, 'layout.webview.ref')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /layout/)
  })

  test('denies config even though it holds real data', () => {
    const result = resolveStorePath(store, 'config.poi')
    assert.equal(result.ok, false)
  })

  test('lists the allowed roots when a root is denied', () => {
    const result = resolveStorePath(store, 'layout')
    assert.match(result.ok === false ? result.error : '', /info/)
  })

  test('rejects an unknown root', () => {
    const result = resolveStorePath(store, 'nonsense.deep')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /nonsense/)
  })

  test('suggests sibling keys when a leaf key is missing', () => {
    const result = resolveStorePath(store, 'info.shps')
    assert.equal(result.ok, false)
    const error = result.ok === false ? result.error : ''
    assert.match(error, /ships/)
    assert.match(error, /basic/)
  })

  test('names the nearest valid parent when a key is missing', () => {
    const result = resolveStorePath(store, 'info.shps')
    assert.match(result.ok === false ? result.error : '', /info/)
  })

  test('distinguishes a present-but-undefined value from a missing key', () => {
    const withUndefined = { info: { basic: undefined } }
    const result = resolveStorePath(withUndefined, 'info.basic')
    assert.deepEqual(result, { ok: true, value: undefined })
  })

  test('rejects an empty path with a readable message', () => {
    const result = resolveStorePath(store, '')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /empty/i)
  })
})

describe('resolveStorePath under ext', () => {
  const attack = { data: [[1789230676791, '沖ノ島海域(2-4)', '2(道中)']] }
  const store = {
    info: { basic: {} },
    ext: {
      'poi-plugin-akashic-records': { attack },
      'poi-plugin-akashic-records-ex': { attack },
      'poi-plugin-secret': { token: 'nope' },
    },
  }

  test('reads an allowlisted plugin branch', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-akashic-records.attack')
    assert.deepEqual(result, { ok: true, value: attack })
  })

  test('reads a fork listed under its own package name', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-akashic-records-ex.attack')
    assert.deepEqual(result, { ok: true, value: attack })
  })

  test('does not treat the upstream name as a prefix of the fork', () => {
    // A plugin is matched by its whole package name, never by prefix: poi keys
    // ext by package name, and `-ex` is a different package.
    const onlyFork = { ext: { 'poi-plugin-akashic-records-ex': { attack } } }
    const result = resolveStorePath(onlyFork, 'ext.poi-plugin-akashic-records.attack')
    assert.equal(result.ok, false)
  })

  test('reads the accumulated quest list, which poi itself does not keep', () => {
    // `info.quests` only ever holds accepted quests; the offered ones exist
    // solely in this plugin's merged `questList`.
    const questList = { '201': { api_no: 201, api_state: 1 } }
    const withQuests = { ext: { 'poi-plugin-quest-line': { _: { questList } } } }
    const result = resolveStorePath(withQuests, 'ext.poi-plugin-quest-line._.questList')
    assert.deepEqual(result, { ok: true, value: questList })
  })

  test('refuses ext as a whole', () => {
    const result = resolveStorePath(store, 'ext')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /cannot be read whole/)
  })

  test('refuses a plugin that is not allowlisted', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-secret.token')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /poi-plugin-secret/)
  })

  test('names the readable plugin paths when refusing', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-secret')
    assert.match(result.ok === false ? result.error : '', /ext\.poi-plugin-akashic-records/)
  })

  test('still reports a missing key inside an allowlisted plugin', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-akashic-records.nope')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /attack/)
  })
})

describe('resolveStorePath for a plugin-backed root', () => {
  test('reads through normally once the plugin supplies it', () => {
    const quests = { '101': { id: 101 } }
    const result = resolveStorePath({ info: {}, questline: { quests } }, 'questline.quests')
    assert.deepEqual(result, { ok: true, value: quests })
  })
})

describe('readableRoots', () => {
  test('lists allowed roots and allowlisted plugins that are present', () => {
    const roots = readableRoots({
      info: {},
      layout: {},
      ext: { 'poi-plugin-akashic-records': {}, 'poi-plugin-secret': {} },
    })
    assert.deepEqual(roots, ['info', 'ext.poi-plugin-akashic-records'])
  })

  test('omits ext entirely when no allowlisted plugin has state', () => {
    assert.deepEqual(readableRoots({ info: {}, ext: { 'poi-plugin-secret': {} } }), ['info'])
  })

  test('tolerates a store without ext', () => {
    assert.deepEqual(readableRoots({ info: {} }), ['info'])
  })

  test('returns nothing for a non-object store', () => {
    assert.deepEqual(readableRoots(undefined), [])
  })
})
