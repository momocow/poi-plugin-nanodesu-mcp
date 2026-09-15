import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { AKASHIC_EX_PACKAGE, FIELD_TABLE, describeFields, timeRangeAt } from '../src/fields.ts'

const attackPath = `ext.${AKASHIC_EX_PACKAGE}._.attack.data`

/** A row of the right width, contents irrelevant — only the arity is checked. */
const row = (width: number) => Array.from({ length: width }, (_, i) => i)

describe('describeFields', () => {
  test('names the positions of a row-shaped path', () => {
    const described = describeFields('info.resources', row(8))
    assert.deepEqual(described.fields, [
      'fuel',
      'ammo',
      'steel',
      'bauxite',
      'instantBuild',
      'instantRepair',
      'devMaterial',
      'improveMaterial',
    ])
  })

  test('puts instant-build before buckets, as poi stores them', () => {
    // The pair this whole module exists for: reading 4 as buckets reports the
    // scarcest resource as the most plentiful, and the response looks fine.
    const { fields } = describeFields('info.resources', row(8))
    assert.equal(fields?.[4], 'instantBuild')
    assert.equal(fields?.[5], 'instantRepair')
  })

  test('lists the positions in the note, for callers that skip poi_describe', () => {
    const { note } = describeFields('info.resources', row(8))
    assert.match(note ?? '', /\[4\] instantBuild/)
    assert.match(note ?? '', /\[5\] instantRepair/)
  })

  test('names the columns of a rows-shaped path', () => {
    const described = describeFields(attackPath, [row(12)])
    assert.equal(described.fields?.[0], 'time')
    assert.equal(described.fields?.[10], 'mvp')
    assert.match(described.note ?? '', /each row/)
  })

  test('withholds names when the row has grown a column', () => {
    const described = describeFields(attackPath, [row(13)])
    assert.equal(described.fields, undefined)
    assert.match(described.note ?? '', /13 positions.*names for 12|changed/)
  })

  test('withholds names when a row-shaped path changes width', () => {
    const described = describeFields('info.resources', row(9))
    assert.equal(described.fields, undefined)
    assert.match(described.note ?? '', /changed/)
  })

  test('still names the columns of an empty log', () => {
    // Emptiness is not evidence of a changed layout, and a caller looking at an
    // empty table is exactly who needs to know what would be in it.
    const described = describeFields(attackPath, [])
    assert.equal(described.fields?.length, 12)
  })

  test('says nothing about an unannotated path', () => {
    assert.deepEqual(describeFields('info.ships', { 1: { api_id: 1 } }), {})
  })

  test('carries a warning for a path with no positional layout', () => {
    const described = describeFields('info.repairs', [{ api_ship_id: 3 }])
    assert.equal(described.fields, undefined)
    assert.match(described.note ?? '', /roster/i)
    assert.match(described.note ?? '', /info\.ships/)
  })

  test('warns that the game formats its own time strings in JST', () => {
    // An unlabelled "17:44:39" reads as a local time and is wrong by the
    // reader's offset — the same class of trap as the roster id above, except
    // that here the colliding name is "time".
    for (const path of ['info.repairs', 'info.constructions']) {
      const described = describeFields(path, [{ api_complete_time_str: '0' }])
      assert.match(described.note ?? '', /JST/, `${path} should name the game clock`)
      assert.match(described.note ?? '', /api_\*_time\b/, `${path} should point at the epoch`)
    }
  })

  test('warns that a battle index carries a third clock again', () => {
    const described = describeFields('ext.poi-plugin-battle-detail._.indexes', [{ time_: 1 }])
    assert.match(described.note ?? '', /time_/)
    assert.match(described.note ?? '', /host/i)
  })

  test('does not claim a layout for a value that is not an array', () => {
    assert.equal(describeFields('info.resources', { fuel: 1 }).fields, undefined)
  })

  test('every entry names one field per position, with no duplicates', () => {
    // Duplicate names cannot describe distinct positions — the mission log's two
    // "Number" columns are the reason this is checked rather than assumed.
    for (const [path, entry] of Object.entries(FIELD_TABLE)) {
      assert.ok(entry.fields.length > 0, `${path} has no fields`)
      assert.equal(
        new Set(entry.fields).size,
        entry.fields.length,
        `${path} has duplicate field names`,
      )
    }
  })
})

describe('timeRangeAt', () => {
  const at = (ms: number) => [ms, ...row(11)]
  const day = (d: number) => Date.UTC(2026, 8, d)

  test('reports the span a log covers', () => {
    const range = timeRangeAt(attackPath, [at(day(14)), at(day(2)), at(day(9))])
    assert.equal(range?.min, day(2))
    assert.equal(range?.max, day(14))
    assert.equal(range?.from, new Date(day(2)).toISOString())
    assert.equal(range?.counted, 3)
    assert.equal(range?.field, '[0]')
  })

  test('does not depend on the rows being in order', () => {
    // The live attack log is newest-first, but that is an observation about one
    // table, not a promise — reading the ends would swap from and to the day it
    // stops holding.
    const ascending = timeRangeAt(attackPath, [at(day(1)), at(day(5)), at(day(9))])
    const descending = timeRangeAt(attackPath, [at(day(9)), at(day(5)), at(day(1))])
    assert.deepEqual(ascending, descending)
  })

  test('reads the numeric field of an object-shaped index, not its display string', () => {
    const path = 'ext.poi-plugin-battle-detail._.indexes'
    const range = timeRangeAt(path, [
      { id: 1, time_: day(3), time: '2026-09-03 00:00:00' },
      { id: 2, time_: day(8), time: '2026-09-08 00:00:00' },
    ])
    assert.equal(range?.field, 'time_')
    assert.equal(range?.max, day(8))
  })

  test('withholds a range whose values cannot be milliseconds', () => {
    // Seconds would otherwise be reported as 1970 for every row: a confident
    // answer, uniformly wrong.
    assert.equal(timeRangeAt(attackPath, [at(Math.floor(day(4) / 1000))]), undefined)
  })

  test('skips rows with no usable instant', () => {
    const range = timeRangeAt(attackPath, [at(day(6)), ['', ...row(11)], at(day(7))])
    assert.equal(range?.counted, 2)
  })

  test('says nothing for an empty log or an unannotated path', () => {
    assert.equal(timeRangeAt(attackPath, []), undefined)
    assert.equal(timeRangeAt('info.ships', { 1: { api_id: 1 } }), undefined)
  })

  test('every annotated log can say where its time column is', () => {
    // A column inserted before `time` must not leave the horizon reading the
    // wrong position, which is why TIME_FIELDS is derived, not written out.
    const described = describeFields(attackPath, [row(12)])
    assert.equal(described.fields?.indexOf('time'), 0)
  })

})
