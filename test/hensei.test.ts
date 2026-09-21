import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  buildSaveAction,
  henseiCalcPath,
  loadHenseiCalc,
  readHenseiTitles,
  HENSEI_DATA_PATH,
  type HenseiCalc,
  type HenseiFleet,
} from '../src/hensei.ts'
import { poiHenseiSave, type HenseiSaveDeps } from '../src/tools.ts'
import store from './fixtures/store.json' with { type: 'json' }

const SAVED: HenseiFleet[] = [[{ id: 101, lv: 5, slots: [] }]]

/** Records what their converter was handed, so the call can be asserted. */
const fakeCalc = (): HenseiCalc & { seen: unknown[][] } => {
  const seen: unknown[][] = []
  return {
    seen,
    getHenseiDataByApi: (fleets, ships, equips) => {
      seen.push([fleets, ships, equips])
      return SAVED
    },
    getHenseiDataByCode: (code) => {
      seen.push([code])
      return SAVED
    },
  }
}

const withRecords = (data: Record<string, unknown>): unknown => ({
  ...store,
  ext: { 'poi-plugin-hensei-nikki': { _: { henseiData: { data } } } },
})

const deps = (overrides: Partial<HenseiSaveDeps> = {}): HenseiSaveDeps & { sent: unknown[] } => {
  const sent: unknown[] = []
  return {
    sent,
    store: withRecords({}),
    dispatch: (action) => sent.push(action),
    calc: fakeCalc(),
    ...overrides,
  }
}

const errorOf = (result: { ok: boolean; error?: string }) => {
  assert.equal(result.ok, false, 'expected a refusal')
  return result.error ?? ''
}

describe('loadHenseiCalc', () => {
  const calc = { getHenseiDataByApi: () => [], getHenseiDataByCode: () => [] }

  test('loads their converter from poi’s plugin directory', () => {
    const seen: string[] = []
    const loaded = loadHenseiCalc('/data/poi', (id) => {
      seen.push(id)
      return calc
    })
    assert.equal(loaded, calc)
    assert.deepEqual(seen, [henseiCalcPath('/data/poi')])
    assert.equal(
      henseiCalcPath('/data/poi'),
      '/data/poi/plugins/node_modules/poi-plugin-hensei-nikki/utils/calc.js',
    )
  })

  test('has nothing to load without a data directory or a require', () => {
    assert.equal(loadHenseiCalc(undefined, () => calc), undefined)
    assert.equal(loadHenseiCalc('', () => calc), undefined)
    assert.equal(loadHenseiCalc('/data/poi', undefined), undefined)
  })

  test('treats a plugin that is absent or changed as simply unavailable', () => {
    // Not installed: require throws. Changed: the exports are no longer theirs.
    assert.equal(
      loadHenseiCalc('/data/poi', () => {
        throw new Error('Cannot find module')
      }),
      undefined,
    )
    assert.equal(loadHenseiCalc('/data/poi', () => ({ getHenseiDataByApi: 'not a function' })), undefined)
  })
})

describe('readHenseiTitles', () => {
  test('lists the titles already taken', () => {
    const result = readHenseiTitles(withRecords({ '決戦': {}, '遠征': {} }))
    assert.deepEqual(result.ok && result.titles, ['決戦', '遠征'])
  })

  test('refuses when the plugin has no state, naming the real cause', () => {
    // The fixture has no `ext` at all — which is exactly the shape of a poi
    // where the plugin is not loaded and a dispatch would vanish.
    const error = errorOf(readHenseiTitles(store))
    assert.match(error, /reducer is not mounted/)
    assert.match(error, /silently discarded/)
  })
})

describe('buildSaveAction', () => {
  test('is the action their reducer handles', () => {
    assert.deepEqual(buildSaveAction('決戦', SAVED, 'note'), {
      type: '@@HENSEI_SAVE_DATA',
      title: '決戦',
      fleets: { version: 'poi-h-v1', fleets: SAVED, note: 'note' },
    })
  })
})

describe('poiHenseiSave', () => {
  test('saves the live fleets their Add flow would save', () => {
    const d = deps()
    const result = poiHenseiSave(d, { title: ' 決戦 ', decks: [1], note: ' 秋イベ ' })

    assert.deepEqual(result.ok && result.data, {
      title: '決戦',
      fleets: 1,
      ships: 1,
      overwritten: false,
    })
    assert.deepEqual(d.sent, [
      {
        type: '@@HENSEI_SAVE_DATA',
        title: '決戦',
        fleets: { version: 'poi-h-v1', fleets: SAVED, note: '秋イベ' },
      },
    ])

    // The converter is handed the deck's instance ids, plus poi's own indexes.
    const [fleets, ships, equips] = (d.calc as ReturnType<typeof fakeCalc>).seen[0] ?? []
    const firstDeck = store.info.fleets[0]!
    assert.deepEqual(fleets, [firstDeck.api_ship.map((id) => ({ id }))])
    assert.equal(ships, store.info.ships)
    assert.equal(equips, store.info.equips)
  })

  test('imports a composition instead of the live fleets', () => {
    const d = deps()
    const code = { version: 4, f1: {} }
    const result = poiHenseiSave(d, { title: 'imported', code })

    assert.equal(result.ok, true)
    assert.deepEqual((d.calc as ReturnType<typeof fakeCalc>).seen[0], [code])
  })

  test('refuses a title already taken, and says how to proceed', () => {
    const d = deps({ store: withRecords({ 決戦: {} }) })
    const error = errorOf(poiHenseiSave(d, { title: '決戦', decks: [1] }))

    assert.match(error, /already exists/)
    assert.match(error, /overwrite: true/)
    assert.ok(error.includes(HENSEI_DATA_PATH), 'should say where to read the old record')
    assert.deepEqual(d.sent, [], 'nothing may be dispatched when the save is refused')
  })

  test('replaces it when overwrite is asked for, and reports that it did', () => {
    const d = deps({ store: withRecords({ 決戦: {} }) })
    const result = poiHenseiSave(d, { title: '決戦', decks: [1], overwrite: true })

    assert.equal(result.ok && result.data.overwritten, true)
    assert.equal(d.sent.length, 1)
  })

  test('refuses to dispatch into a store where the plugin is not loaded', () => {
    // The dispatch would succeed and change nothing, which is the one failure
    // a caller cannot detect for itself.
    const d = deps({ store })
    assert.match(errorOf(poiHenseiSave(d, { title: 't', decks: [1] })), /reducer is not mounted/)
    assert.deepEqual(d.sent, [])
  })

  test('reports the plugin missing rather than failing obscurely', () => {
    assert.match(
      errorOf(poiHenseiSave(deps({ calc: undefined }), { title: 't', decks: [1] })),
      /poi-plugin-hensei-nikki' poi plugin is not installed/,
    )
    assert.match(
      errorOf(poiHenseiSave(deps({ dispatch: undefined }), { title: 't', decks: [1] })),
      /did not provide a dispatch/,
    )
  })

  test('requires a title that is not blank', () => {
    assert.match(errorOf(poiHenseiSave(deps(), { title: '   ', decks: [1] })), /title is required/)
  })

  test('requires exactly one source', () => {
    assert.match(errorOf(poiHenseiSave(deps(), { title: 't' })), /pass decks .* or code/)
    assert.match(
      errorOf(poiHenseiSave(deps(), { title: 't', decks: [1], code: {} })),
      /not both/,
    )
  })

  test('rejects deck numbers that are not decks', () => {
    assert.match(errorOf(poiHenseiSave(deps(), { title: 't', decks: [] })), /non-empty/)
    assert.match(errorOf(poiHenseiSave(deps(), { title: 't', decks: [0, 5] })), /from 1 to 4/)
    assert.match(errorOf(poiHenseiSave(deps(), { title: 't', decks: [1, 1] })), /more than once/)
  })

  test('says how many fleets the account has when asked for one it lacks', () => {
    // The fixture account has two.
    const error = errorOf(poiHenseiSave(deps(), { title: 't', decks: [3] }))
    assert.match(error, /no deck 3/)
    assert.match(error, /has 2 fleets/)
  })

  test('refuses an empty record, which would not survive a restart', () => {
    const empty: HenseiCalc = { getHenseiDataByApi: () => [], getHenseiDataByCode: () => [] }
    const d = deps({ calc: empty })
    assert.match(errorOf(poiHenseiSave(d, { title: 't', decks: [1] })), /nothing to save/)
    assert.deepEqual(d.sent, [])
  })

  test('turns a throwing conversion into a refusal, not a crash', () => {
    const throwing: HenseiCalc = {
      getHenseiDataByApi: () => {
        throw new TypeError('API ship must be an object')
      },
      getHenseiDataByCode: () => {
        throw new TypeError('unsupported legacy data depth')
      },
    }
    assert.match(
      errorOf(poiHenseiSave(deps({ calc: throwing }), { title: 't', decks: [1] })),
      /could not read the fleets: API ship must be an object/,
    )
    assert.match(
      errorOf(poiHenseiSave(deps({ calc: throwing }), { title: 't', code: [] })),
      /could not read the composition: unsupported legacy data depth/,
    )
  })
})
