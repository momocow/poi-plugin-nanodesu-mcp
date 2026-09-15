import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { poiGet, poiLookup, poiDescribe, poiBattle, LOOKUP_KINDS, MAX_BATTLE_IDS } from '../src/tools.ts'
import store from './fixtures/store.json' with { type: 'json' }

const ok = <T extends { ok: boolean }>(result: T): T => {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`)
  return result
}

const errorOf = (result: { ok: boolean; error?: string }) => {
  assert.equal(result.ok, false)
  return result.error ?? ''
}

describe('poiGet', () => {
  test('reads a record from real store data', () => {
    const result = ok(poiGet(store, { path: 'info.basic' }))
    assert.equal(result.ok && result.data.kind, 'object')
  })

  test('reads a collection and reports its true total', () => {
    const result = poiGet(store, { path: 'info.ships' })
    assert.equal(result.ok && result.data.kind, 'object-map')
    if (result.ok && result.data.kind === 'object-map') {
      assert.equal(result.data.total, Object.keys(store.info.ships).length)
    }
  })

  test('finds damaged ships with a field-to-field filter', () => {
    const result = poiGet(store, {
      path: 'info.ships',
      where: 'api_nowhp < api_maxhp',
      select: ['api_id', 'api_ship_id', 'api_nowhp', 'api_maxhp'],
    })
    assert.equal(result.ok, true)
    if (result.ok && result.data.kind === 'object-map') {
      const expected = Object.values(store.info.ships).filter(
        (s) => s.api_nowhp < s.api_maxhp,
      ).length
      assert.equal(result.data.returned, expected)
      assert.ok(expected > 0, 'fixture should contain damaged ships')
      for (const ship of Object.values(result.data.items)) {
        assert.deepEqual(Object.keys(ship as object).sort(), [
          'api_id',
          'api_maxhp',
          'api_nowhp',
          'api_ship_id',
        ])
      }
    }
  })

  test('reads fleets as an array in order', () => {
    const result = poiGet(store, { path: 'info.fleets', select: ['api_name'] })
    assert.equal(result.ok && result.data.kind, 'array')
    if (result.ok && result.data.kind === 'array') {
      assert.deepEqual(result.data.items[0], { api_name: 'First Fleet' })
    }
  })

  test('applies a default limit so an unbounded query stays bounded', () => {
    const result = poiGet(store, { path: 'info.ships' })
    if (result.ok && result.data.kind === 'object-map') {
      assert.ok(result.data.returned <= 200)
    }
  })

  test('truncates rather than overflowing the byte cap', () => {
    const result = poiGet(store, { path: 'info.ships', maxBytes: 2000 })
    assert.equal(result.ok, true)
    if (result.ok && result.data.kind === 'object-map') {
      assert.equal(result.data.truncated, true)
      assert.ok(result.data.returned < result.data.total)
    }
  })

  test('refuses a maxBytes above the hard maximum', () => {
    const error = errorOf(poiGet(store, { path: 'info.ships', maxBytes: 999999 }))
    assert.match(error, /262144/)
  })

  test('denies the layout root by name', () => {
    const error = errorOf(poiGet(store, { path: 'layout.webview.ref' }))
    assert.match(error, /layout/)
  })

  test('denies the config root', () => {
    assert.equal(poiGet(store, { path: 'config.poi' }).ok, false)
  })

  test('suggests sibling keys for a misspelled path', () => {
    const error = errorOf(poiGet(store, { path: 'info.shps' }))
    assert.match(error, /ships/)
  })

  test('reports a where parse error with position and grammar hint', () => {
    const error = errorOf(poiGet(store, { path: 'info.ships', where: 'api_lv >' }))
    assert.match(error, /position/i)
    assert.match(error, /api_nowhp < api_maxhp/)
  })

  test('hints when a branch is empty rather than erroring', () => {
    const emptyStore = { info: { ships: {} } }
    const result = poiGet(emptyStore, { path: 'info.ships' })
    assert.equal(result.ok, true)
    if (result.ok && result.data.kind === 'object-map') {
      assert.equal(result.data.total, 0)
      assert.match(result.data.hint ?? '', /not.*loaded|empty/i)
    }
  })

  test('blames the quest panel, not the game load, for an empty quest list', () => {
    const empty = { ext: { 'poi-plugin-quest-line': { _: { questList: {} } } } }
    const result = poiGet(empty, { path: 'ext.poi-plugin-quest-line._.questList' })
    assert.equal(result.ok, true)
    assert.match(
      result.ok && result.data.kind === 'object-map' ? (result.data.hint ?? '') : '',
      /quest panel/i,
    )
  })

  test('does not hint when a collection has results', () => {
    const result = poiGet(store, { path: 'info.ships' })
    if (result.ok && result.data.kind === 'object-map') {
      assert.equal(result.data.hint, undefined)
    }
  })

  test('honours treatAs to read a keyed map whole', () => {
    const result = poiGet(store, { path: 'info.basic', treatAs: 'collection' })
    assert.equal(result.ok && result.data.kind, 'object-map')
  })

  test('errors when a single value exceeds the cap', () => {
    const error = errorOf(poiGet(store, { path: 'info.basic', maxBytes: 20 }))
    assert.match(error, /bytes/)
  })
})

describe('poiLookup', () => {
  const shipId = Number(Object.keys(store.const.$ships)[0])

  test('resolves a master ship record by id', () => {
    const result = ok(poiLookup(store, { kind: 'ships', ids: [shipId] }))
    if (result.ok) {
      const record = (result.data as Record<string, Record<string, unknown>>)[String(shipId)]
      assert.equal(typeof record?.api_name, 'string')
    }
  })

  test('projects master data with select', () => {
    const result = poiLookup(store, { kind: 'ships', ids: [shipId], select: ['api_name'] })
    if (result.ok) {
      const record = (result.data as Record<string, unknown>)[String(shipId)]
      assert.deepEqual(Object.keys(record as object), ['api_name'])
    }
  })

  test('omits ids that are not present rather than erroring', () => {
    const result = ok(poiLookup(store, { kind: 'ships', ids: [shipId, 999999] }))
    if (result.ok) {
      assert.deepEqual(Object.keys(result.data as object), [String(shipId)])
    }
  })

  test('rejects an unknown kind and lists the valid ones', () => {
    const error = errorOf(poiLookup(store, { kind: 'nonsense', ids: [1] }))
    assert.match(error, /ships/)
  })

  test('rejects more than 200 ids', () => {
    const ids = Array.from({ length: 201 }, (_, i) => i)
    assert.match(errorOf(poiLookup(store, { kind: 'ships', ids })), /200/)
  })

  test('rejects an empty id list', () => {
    assert.equal(poiLookup(store, { kind: 'ships', ids: [] }).ok, false)
  })

  test('exposes every documented kind', () => {
    assert.deepEqual(Object.keys(LOOKUP_KINDS).sort(), [
      'equipTypes',
      'equips',
      'exslotEquipShips',
      'exslotEquips',
      'graphs',
      'mapareas',
      'maps',
      'missions',
      'shipTypes',
      'shipUpgrades',
      'shipgraph',
      'ships',
      'useitems',
    ])
  })

  test('reports a missing master table without throwing', () => {
    const error = errorOf(poiLookup(store, { kind: 'missions', ids: [1] }))
    assert.match(error, /missions|\$missions/)
  })
})

describe('poiBattle', () => {
  const battle = (shipIds: number[]) => ({
    type: 'Boss',
    fleet: {
      main: shipIds.map((id, i) => ({
        api_ship_id: id,
        api_lv: 90 + i,
        poi_slot: [{ api_name: '20.3cm' }],
      })),
    },
  })
  const records: Record<number, unknown> = { 1: battle([507, 560]), 2: battle([283]) }
  const read = (id: number) => {
    const found = records[id]
    if (found === undefined) throw new Error('ENOENT')
    return found
  }

  test('reads records by id', () => {
    const result = ok(poiBattle(read, { ids: [1, 2] }))
    if (result.ok && result.data.kind === 'object-map') {
      assert.deepEqual(Object.keys(result.data.items), ['1', '2'])
      assert.equal(result.data.total, 2)
    }
  })

  test('projects the fleet across ships with a wildcard select', () => {
    // The point of the tool: a whole record is ~22 KB, this is a few hundred bytes.
    const result = ok(poiBattle(read, { ids: [1], select: ['fleet.main[].api_ship_id'] }))
    if (result.ok && result.data.kind === 'object-map') {
      assert.deepEqual(result.data.items['1'], { 'fleet.main[].api_ship_id': [507, 560] })
    }
  })

  test('omits an unreadable id and says which', () => {
    const result = ok(poiBattle(read, { ids: [1, 999] }))
    if (result.ok && result.data.kind === 'object-map') {
      assert.deepEqual(Object.keys(result.data.items), ['1'])
      assert.match(result.data.hint ?? '', /999/)
    }
  })

  test('truncates rather than overflowing the byte cap', () => {
    const result = ok(poiBattle(read, { ids: [1, 2], maxBytes: 200 }))
    if (result.ok && result.data.kind === 'object-map') {
      assert.equal(result.data.truncated, true)
      assert.match(result.data.hint ?? '', /select|maxBytes/)
    }
  })

  test('refuses a batch too large to be worth reading', () => {
    const ids = Array.from({ length: MAX_BATTLE_IDS + 1 }, (_, i) => i + 1)
    assert.match(errorOf(poiBattle(read, { ids })), new RegExp(String(MAX_BATTLE_IDS)))
  })

  test('rejects an empty id list and points at the index', () => {
    assert.match(errorOf(poiBattle(read, { ids: [] })), /indexes/)
  })

  test('reports itself unavailable when there is nowhere to read from', () => {
    assert.match(errorOf(poiBattle(undefined, { ids: [1] })), /not available/i)
  })
})

describe('poiDescribe', () => {
  test('lists the keys of a branch', () => {
    const result = ok(poiDescribe(store, { path: 'info' }))
    if (result.ok) {
      assert.ok(result.data.keys?.includes('ships'))
      assert.equal(result.data.kind, 'object')
    }
  })

  test('reports a collection total and sample fields', () => {
    const result = ok(poiDescribe(store, { path: 'info.ships' }))
    if (result.ok) {
      assert.equal(result.data.kind, 'object-map')
      assert.equal(result.data.total, Object.keys(store.info.ships).length)
      assert.ok(result.data.sampleFields?.includes('api_nowhp'))
    }
  })

  test('caps how many keys it lists', () => {
    const result = ok(poiDescribe(store, { path: 'info.ships' }))
    if (result.ok) {
      assert.ok((result.data.sampleKeys?.length ?? 0) <= 50)
    }
  })

  test('describes an array branch', () => {
    const result = ok(poiDescribe(store, { path: 'info.fleets' }))
    if (result.ok) {
      assert.equal(result.data.kind, 'array')
      assert.equal(result.data.total, store.info.fleets.length)
    }
  })

  test('describes a scalar without pretending it has fields', () => {
    const result = ok(poiDescribe(store, { path: 'info.basic.api_level' }))
    if (result.ok) {
      assert.equal(result.data.kind, 'scalar')
      assert.equal(result.data.type, 'number')
    }
  })

  test('respects the allowlist', () => {
    assert.equal(poiDescribe(store, { path: 'layout' }).ok, false)
  })

  test('describes the root branches when given no path', () => {
    const result = ok(poiDescribe(store, {}))
    if (result.ok) {
      assert.ok(result.data.keys?.includes('info'))
      assert.equal(result.data.keys?.includes('layout'), false)
    }
  })

  test('advertises an allowlisted plugin branch that has state', () => {
    const withPlugin = { ...store, ext: { 'poi-plugin-akashic-records': { attack: {} } } }
    const result = ok(poiDescribe(withPlugin, {}))
    if (result.ok) {
      assert.ok(result.data.keys?.includes('ext.poi-plugin-akashic-records'))
    }
  })
})
