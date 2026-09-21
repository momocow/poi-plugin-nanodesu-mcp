import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  parseFieldPath,
  getByPath,
  resolveStorePath,
  readableRoots,
  WILDCARD,
} from '../src/paths.ts'

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

  test('parses [] as a wildcard distinct from an index', () => {
    const segments = parseFieldPath('main[].api_lv')
    assert.equal(segments[1], WILDCARD)
    assert.deepEqual(parseFieldPath('main[0].api_lv')[1], 0)
  })

  test('still rejects a non-numeric index', () => {
    assert.throws(() => parseFieldPath('main[x]'), /integer/i)
  })
})

describe('getByPath with []', () => {
  const battle = {
    fleet: {
      main: [
        { api_lv: 97, poi_slot: [{ api_name: '20.3cm' }, { api_name: '甲標的' }] },
        { api_lv: 138, poi_slot: [{ api_name: '流星改' }] },
      ],
    },
  }

  test('maps over an array instead of indexing it', () => {
    assert.deepEqual(getByPath(battle, parseFieldPath('fleet.main[].api_lv')), [97, 138])
  })

  test('maps through nested arrays', () => {
    assert.deepEqual(getByPath(battle, parseFieldPath('fleet.main[].poi_slot[].api_name')), [
      ['20.3cm', '甲標的'],
      ['流星改'],
    ])
  })

  test('keeps a hole rather than shifting the rest', () => {
    const holed = { main: [{ api_lv: 1 }, {}, { api_lv: 3 }] }
    assert.deepEqual(getByPath(holed, parseFieldPath('main[].api_lv')), [1, undefined, 3])
  })

  test('returns undefined when the branch is not an array', () => {
    assert.equal(getByPath({ main: { api_lv: 1 } }, parseFieldPath('main[].api_lv')), undefined)
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

  test('says which plugin to install when an allowlisted one has no state', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-quest-line._.questList')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /poi-plugin-quest-line/)
    assert.match(result.ok === false ? result.error : '', /not.*installed/i)
  })

  test('does not name the plugins the user happens to have installed', () => {
    // Under ext, "available keys" would be the user's whole plugin list, which
    // is nobody's business but the allowlisted entries.
    const result = resolveStorePath(store, 'ext.poi-plugin-quest-line')
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.ok === false ? result.error : '', /poi-plugin-secret/)
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

describe('resolveStorePath for a partly-readable plugin', () => {
  const indexes = [{ id: 1789232781382, map: '2-4', rank: 'S' }]
  const store = {
    info: {},
    ext: {
      'poi-plugin-battle-detail': { _: { indexes, sortieIndexes: { size: 2, _root: {} }, ui: {} } },
    },
  }

  test('reads the allowlisted sub-path', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-battle-detail._.indexes')
    assert.deepEqual(result, { ok: true, value: indexes })
  })

  test('reads beneath the allowlisted sub-path', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-battle-detail._.indexes[0].rank')
    assert.deepEqual(result, { ok: true, value: 'S' })
  })

  test('refuses the sibling that does not survive serialization', () => {
    // sortieIndexes is an Immutable.js List, whose own properties are internals.
    const result = resolveStorePath(store, 'ext.poi-plugin-battle-detail._.sortieIndexes')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /only part of/i)
  })

  test('refuses the plugin state as a whole', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-battle-detail._')
    assert.equal(result.ok, false)
  })

  test('names what is readable when refusing', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-battle-detail._.ui')
    assert.match(result.ok === false ? result.error : '', /_\.indexes/)
  })

  test('advertises the readable sub-path, not the plugin', () => {
    const roots = readableRoots(store)
    assert.ok(roots.includes('ext.poi-plugin-battle-detail._.indexes'))
    assert.equal(roots.includes('ext.poi-plugin-battle-detail'), false)
  })
})

describe('resolveStorePath for the senka histories', () => {
  // The shape v5.5.1's combineReducers produces: plain records of numbers.
  const senka = {
    experienceHistory: { 0: 4200000, 1: 4213000, 1000: 4225000 },
    rank501: { 0: 1800, 1: 1855 },
    rankUser: { 0: 1200, 1: 1310 },
    currentRank: 742,
    excludedQuests: [284],
  }
  const store = { info: {}, ext: { 'poi-plugin-senka-calc': { _: senka } } }

  test('reads the plugin state whole', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-senka-calc._')
    assert.deepEqual(result, { ok: true, value: senka })
  })

  test('reads a single history branch', () => {
    const result = resolveStorePath(store, 'ext.poi-plugin-senka-calc._.rank501')
    assert.deepEqual(result, { ok: true, value: senka.rank501 })
  })

  test('advertises it among the readable branches', () => {
    assert.ok(readableRoots(store).includes('ext.poi-plugin-senka-calc'))
  })
})

describe('resolveStorePath rejects a wildcard', () => {
  test('[] projects across an array and names no branch', () => {
    const result = resolveStorePath({ info: { ships: [] } }, 'info.ships[].api_lv')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /select/i)
  })
})

describe('resolveStorePath for a plugin-backed root', () => {
  test('names the plugin that supplies it rather than reporting a typo', () => {
    const result = resolveStorePath({ info: {} }, 'questline.quests')
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /poi-plugin-quest-line/)
    assert.match(result.ok === false ? result.error : '', /not.*installed/i)
  })

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
