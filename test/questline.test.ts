import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  loadQuestLineDb,
  questLineAssetPath,
  withQuestLine,
  QUEST_LINE_ROOT,
} from '../src/questline.ts'

const db = { meta: { questCount: 2 }, quests: { '101': { id: 101, prereqIds: [] } } }

const reader = (contents: string) => () => contents
const missing = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

describe('questLineAssetPath', () => {
  test('points at the asset inside poi’s plugin directory', () => {
    assert.equal(
      questLineAssetPath('/data/poi'),
      '/data/poi/plugins/node_modules/poi-plugin-quest-line/assets/quests.json',
    )
  })
})

describe('loadQuestLineDb', () => {
  test('loads the graph', () => {
    assert.deepEqual(loadQuestLineDb('/data/poi', reader(JSON.stringify(db))), db)
  })

  test('reads from the path built for the given data directory', () => {
    const seen: string[] = []
    loadQuestLineDb('/data/poi', (path) => {
      seen.push(path)
      return JSON.stringify(db)
    })
    assert.deepEqual(seen, [questLineAssetPath('/data/poi')])
  })

  test('returns nothing when the plugin is not installed', () => {
    assert.equal(loadQuestLineDb('/data/poi', missing), undefined)
  })

  test('returns nothing when poi did not provide a data directory', () => {
    // Outside poi, or a poi too old to set APPDATA_PATH.
    assert.equal(loadQuestLineDb(undefined), undefined)
    assert.equal(loadQuestLineDb(''), undefined)
  })

  test('returns nothing for a corrupt asset rather than throwing', () => {
    assert.equal(loadQuestLineDb('/data/poi', reader('{ not json')), undefined)
  })

  test('rejects an asset that is missing the quest table', () => {
    // A later version of the plugin could reshape the file; a wrong shape must
    // not be published as if it were the graph.
    assert.equal(loadQuestLineDb('/data/poi', reader('{"meta":{}}')), undefined)
    assert.equal(loadQuestLineDb('/data/poi', reader('null')), undefined)
    assert.equal(loadQuestLineDb('/data/poi', reader('[]')), undefined)
  })
})

describe('withQuestLine', () => {
  test('publishes the graph as a root beside poi’s own', () => {
    const store = { info: { basic: {} } }
    const overlaid = withQuestLine(store, db) as Record<string, unknown>
    assert.equal(overlaid[QUEST_LINE_ROOT], db)
    assert.deepEqual(overlaid.info, store.info)
  })

  test('never writes into poi’s store', () => {
    const store = { info: {} }
    withQuestLine(store, db)
    assert.equal(QUEST_LINE_ROOT in store, false)
  })

  test('leaves the store untouched when the graph is unavailable', () => {
    const store = { info: {} }
    assert.equal(withQuestLine(store, undefined), store)
  })

  test('tolerates a store that is not an object', () => {
    assert.equal(withQuestLine(undefined, db), undefined)
    assert.equal(withQuestLine(null, db), null)
  })
})
