import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { gzipSync } from 'node:zlib'

import { battleDir, battleFile, makeBattleReader } from '../src/battles.ts'

const record = { type: 'Boss', fleet: { main: [{ api_ship_id: 507 }] } }
const gzipped = gzipSync(Buffer.from(JSON.stringify(record), 'utf8'))

describe('battleFile', () => {
  test('names the record after its id, inside poi’s data directory', () => {
    assert.equal(battleDir('/data/poi'), '/data/poi/battle-detail')
    assert.equal(battleFile('/data/poi', 1789232781382), '/data/poi/battle-detail/1789232781382.json.gz')
  })
})

describe('makeBattleReader', () => {
  test('reads and inflates a record', () => {
    const read = makeBattleReader('/data/poi', () => gzipped)
    assert.deepEqual(read?.(1789232781382), record)
  })

  test('reads from the path built for the id', () => {
    const seen: string[] = []
    const read = makeBattleReader('/data/poi', (path) => {
      seen.push(path)
      return gzipped
    })
    read?.(42)
    assert.deepEqual(seen, [battleFile('/data/poi', 42)])
  })

  test('has nothing to read without a data directory', () => {
    // Outside poi, or a poi too old to set APPDATA_PATH.
    assert.equal(makeBattleReader(undefined), undefined)
    assert.equal(makeBattleReader(''), undefined)
  })

  test('propagates a missing file so the caller can report that id', () => {
    // Which id failed matters; a reader that swallowed this would lose it.
    const read = makeBattleReader('/data/poi', () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    assert.throws(() => read?.(1), /ENOENT/)
  })
})
