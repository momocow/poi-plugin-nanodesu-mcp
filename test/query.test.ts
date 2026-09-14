import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { isCollection, compileWhere, applySelect, applyQuery } from '../src/query.ts'

describe('isCollection', () => {
  test('treats an array as a collection', () => {
    assert.equal(isCollection([1, 2]), true)
  })

  test('treats an object with all integer-like keys as a collection', () => {
    assert.equal(isCollection({ '38761': {}, '43830': {} }), true)
  })

  test('treats a record with named keys as a value', () => {
    assert.equal(isCollection({ api_member_id: 1, api_nickname: 'x' }), false)
  })

  test('treats a mix of integer-like and named keys as a value', () => {
    assert.equal(isCollection({ '1': {}, api_nickname: 'x' }), false)
  })

  test('treats an empty object as a collection', () => {
    assert.equal(isCollection({}), true)
  })

  test('treats scalars and null as values', () => {
    assert.equal(isCollection(3), false)
    assert.equal(isCollection('x'), false)
    assert.equal(isCollection(null), false)
    assert.equal(isCollection(undefined), false)
  })
})

describe('compileWhere', () => {
  const ship = {
    api_id: 38761,
    api_lv: 47,
    api_nowhp: 18,
    api_maxhp: 31,
    api_cond: 99,
    api_name: '長鯨',
    api_locked: 1,
    api_slot: [12043, 12044, -1],
    api_exp: [109619, 220, 0],
    api_sally_area: null,
  }

  test('compares a field to a literal number', () => {
    assert.equal(compileWhere('api_lv > 40')(ship), true)
    assert.equal(compileWhere('api_lv > 50')(ship), false)
  })

  test('compares a field to another field', () => {
    assert.equal(compileWhere('api_nowhp < api_maxhp')(ship), true)
    assert.equal(compileWhere('api_maxhp < api_nowhp')(ship), false)
  })

  test('supports = and == for equality', () => {
    assert.equal(compileWhere('api_locked = 1')(ship), true)
    assert.equal(compileWhere('api_locked == 1')(ship), true)
  })

  test('supports != for inequality', () => {
    assert.equal(compileWhere('api_locked != 0')(ship), true)
  })

  test('compares string literals in double and single quotes', () => {
    assert.equal(compileWhere('api_name = "長鯨"')(ship), true)
    assert.equal(compileWhere("api_name = '長鯨'")(ship), true)
    assert.equal(compileWhere('api_name = "雪風"')(ship), false)
  })

  test('reads indexed fieldpaths', () => {
    assert.equal(compileWhere('api_exp[0] > 100000')(ship), true)
  })

  test('combines terms with and', () => {
    assert.equal(compileWhere('api_lv > 40 and api_locked = 1')(ship), true)
    assert.equal(compileWhere('api_lv > 40 and api_locked = 0')(ship), false)
  })

  test('combines terms with or', () => {
    assert.equal(compileWhere('api_lv > 99 or api_locked = 1')(ship), true)
    assert.equal(compileWhere('api_lv > 99 or api_locked = 0')(ship), false)
  })

  test('binds and tighter than or', () => {
    // false or (true and true) -> true; if or bound tighter this would be false
    assert.equal(compileWhere('api_lv > 99 or api_lv > 40 and api_locked = 1')(ship), true)
  })

  test('respects parentheses over default precedence', () => {
    assert.equal(compileWhere('(api_lv > 99 or api_lv > 40) and api_locked = 0')(ship), false)
  })

  test('negates with not', () => {
    assert.equal(compileWhere('not api_lv > 99')(ship), true)
    assert.equal(compileWhere('not (api_lv > 40)')(ship), false)
  })

  test('binds not tighter than and', () => {
    assert.equal(compileWhere('not api_lv > 99 and api_locked = 1')(ship), true)
  })

  test('tests membership with in', () => {
    assert.equal(compileWhere('api_id in [38761, 43830]')(ship), true)
    assert.equal(compileWhere('api_id in [1, 2]')(ship), false)
  })

  test('tests array membership with contains', () => {
    assert.equal(compileWhere('api_slot contains 12043')(ship), true)
    assert.equal(compileWhere('api_slot contains 99999')(ship), false)
  })

  test('tests presence with exists', () => {
    assert.equal(compileWhere('api_lv exists')(ship), true)
    assert.equal(compileWhere('api_nope exists')(ship), false)
  })

  describe('rows that are positional arrays', () => {
    // Shaped like a Logbook sortie log row: [timestamp, map, cell, ..., rank].
    const row = [1789232781382, '沖ノ島海域(2-4)', '16(Boss点)', '進撃', '勝利S']

    test('compares a leading index field', () => {
      assert.equal(compileWhere('[0] > 1789000000000')(row), true)
      assert.equal(compileWhere('[0] < 1789000000000')(row), false)
    })

    test('matches a string column exactly', () => {
      assert.equal(compileWhere('[1] = "沖ノ島海域(2-4)"')(row), true)
      assert.equal(compileWhere('[1] = "鎮守府正面海域(1-1)"')(row), false)
    })

    test('combines index fields with and/or/not', () => {
      assert.equal(compileWhere('[0] > 1 and [4] = "勝利S"')(row), true)
      assert.equal(compileWhere('[4] = "敗北" or [3] = "進撃"')(row), true)
      assert.equal(compileWhere('not [4] = "敗北"')(row), true)
    })

    test('reads an index field after an opening parenthesis', () => {
      assert.equal(compileWhere('([0] > 1 or [0] < 0) and [3] = "進撃"')(row), true)
    })

    test('tests presence by position', () => {
      assert.equal(compileWhere('[4] exists')(row), true)
      assert.equal(compileWhere('[9] exists')(row), false)
    })

    test('still reads an array literal on the value side of the same expression', () => {
      assert.equal(compileWhere('[3] in ["出撃", "進撃"]')(row), true)
      assert.equal(compileWhere('[3] in ["出撃"]')(row), false)
    })

    test('does not mistake an array literal for a field', () => {
      assert.equal(compileWhere('api_id in [38761, 43830]')(ship), true)
      assert.equal(compileWhere('api_id in [1]')(ship), false)
    })

    test('rejects a bracket that is neither an index nor a literal', () => {
      assert.throws(() => compileWhere('[foo] > 1'), /expected|unexpected/i)
    })
  })

  test('treats a present null field as existing', () => {
    assert.equal(compileWhere('api_sally_area exists')(ship), true)
  })

  test('compares against a null literal', () => {
    assert.equal(compileWhere('api_sally_area = null')(ship), true)
  })

  test('tests absence with not ... exists', () => {
    assert.equal(compileWhere('not api_nope exists')(ship), true)
  })

  test('is false for any comparison involving an undefined field', () => {
    assert.equal(compileWhere('api_nope = 1')(ship), false)
    assert.equal(compileWhere('api_nope != 1')(ship), false)
    assert.equal(compileWhere('api_nope < 1')(ship), false)
    assert.equal(compileWhere('api_nope > 1')(ship), false)
    assert.equal(compileWhere('api_nope in [1]')(ship), false)
  })

  test('is false when ordering comparisons get mismatched types', () => {
    assert.equal(compileWhere('api_name > 1')(ship), false)
    assert.equal(compileWhere('api_lv < "x"')(ship), false)
  })

  test('compares strings lexicographically', () => {
    assert.equal(compileWhere('api_name > "A"')({ api_name: 'B' }), true)
    assert.equal(compileWhere('api_name < "A"')({ api_name: 'B' }), false)
  })

  test('supports boolean literals', () => {
    assert.equal(compileWhere('flag = true')({ flag: true }), true)
    assert.equal(compileWhere('flag = false')({ flag: true }), false)
  })

  test('reports the position of a parse error', () => {
    assert.throws(() => compileWhere('api_lv >'), /position/i)
  })

  test('rejects a dangling operator with a readable message', () => {
    assert.throws(() => compileWhere('api_lv and'), /position/i)
  })

  test('rejects an unclosed parenthesis', () => {
    assert.throws(() => compileWhere('(api_lv > 1'), /expected|unclosed/i)
  })

  test('rejects an unterminated string', () => {
    assert.throws(() => compileWhere('api_name = "abc'), /unterminated/i)
  })

  test('rejects a bare fieldpath with no operator', () => {
    assert.throws(() => compileWhere('api_lv'), /operator|expected/i)
  })
})

describe('applySelect', () => {
  const ship = { api_id: 1, api_lv: 47, api_exp: [109619, 220], nested: { deep: 'v' } }

  test('keeps only the requested fields', () => {
    assert.deepEqual(applySelect(ship, ['api_id', 'api_lv']), { api_id: 1, api_lv: 47 })
  })

  test('uses the fieldpath string verbatim as the output key', () => {
    assert.deepEqual(applySelect(ship, ['api_exp[0]']), { 'api_exp[0]': 109619 })
  })

  test('reads nested paths', () => {
    assert.deepEqual(applySelect(ship, ['nested.deep']), { 'nested.deep': 'v' })
  })

  test('omits fields that are absent', () => {
    assert.deepEqual(applySelect(ship, ['api_id', 'api_nope']), { api_id: 1 })
  })

  test('keeps a field that is present but null', () => {
    assert.deepEqual(applySelect({ a: null }, ['a']), { a: null })
  })
})

describe('applyQuery', () => {
  const ships = {
    '1': { api_id: 1, api_lv: 5, api_nowhp: 10, api_maxhp: 10 },
    '2': { api_id: 2, api_lv: 80, api_nowhp: 4, api_maxhp: 20 },
    '3': { api_id: 3, api_lv: 99, api_nowhp: 8, api_maxhp: 30 },
  }

  test('reports an object-map with its keys preserved', () => {
    const result = applyQuery(ships, {})
    assert.equal(result.kind, 'object-map')
    assert.equal(result.kind === 'object-map' ? result.total : -1, 3)
    assert.deepEqual(Object.keys(result.kind === 'object-map' ? result.items : {}), ['1', '2', '3'])
  })

  test('filters a collection with where', () => {
    const result = applyQuery(ships, { where: 'api_nowhp < api_maxhp' })
    assert.equal(result.kind === 'object-map' ? result.returned : -1, 2)
    assert.deepEqual(Object.keys(result.kind === 'object-map' ? result.items : {}), ['2', '3'])
  })

  test('reports total as the pre-filter size', () => {
    const result = applyQuery(ships, { where: 'api_lv > 90' })
    assert.equal(result.kind === 'object-map' ? result.total : -1, 3)
    assert.equal(result.kind === 'object-map' ? result.returned : -1, 1)
  })

  test('keeps map keys after a select that drops the id', () => {
    const result = applyQuery(ships, { select: ['api_lv'] })
    const items = result.kind === 'object-map' ? result.items : {}
    assert.deepEqual(items['2'], { api_lv: 80 })
  })

  test('truncates to limit and reports it', () => {
    const result = applyQuery(ships, { limit: 2 })
    assert.equal(result.kind === 'object-map' ? result.returned : -1, 2)
    assert.equal(result.kind === 'object-map' ? result.truncated : false, true)
  })

  test('does not report truncation when limit is not reached', () => {
    const result = applyQuery(ships, { limit: 10 })
    assert.equal(result.kind === 'object-map' ? result.truncated : true, false)
  })

  test('preserves order for arrays', () => {
    const result = applyQuery([{ n: 3 }, { n: 1 }, { n: 2 }], {})
    assert.equal(result.kind, 'array')
    assert.deepEqual(result.kind === 'array' ? result.items : [], [{ n: 3 }, { n: 1 }, { n: 2 }])
  })

  test('filters arrays too', () => {
    const result = applyQuery([{ n: 3 }, { n: 1 }], { where: 'n > 2' })
    assert.deepEqual(result.kind === 'array' ? result.items : [], [{ n: 3 }])
  })

  test('returns a record as a value and applies select to it', () => {
    const basic = { api_member_id: 1, api_nickname: 'x', api_level: 120 }
    const result = applyQuery(basic, { select: ['api_nickname'] })
    assert.equal(result.kind, 'object')
    assert.deepEqual(result.kind === 'object' ? result.value : null, { api_nickname: 'x' })
  })

  test('ignores where and limit on a value', () => {
    const basic = { api_member_id: 1, api_nickname: 'x' }
    const result = applyQuery(basic, { where: 'api_member_id > 999', limit: 0 })
    assert.equal(result.kind, 'object')
    assert.deepEqual(result.kind === 'object' ? result.value : null, basic)
  })

  test('returns a scalar as a value', () => {
    const result = applyQuery(42, {})
    assert.equal(result.kind, 'scalar')
    assert.equal(result.kind === 'scalar' ? result.value : null, 42)
  })

  test('treatAs value forces a collection to be returned whole', () => {
    const result = applyQuery(ships, { treatAs: 'value' })
    assert.equal(result.kind, 'object')
    assert.deepEqual(result.kind === 'object' ? result.value : null, ships)
  })

  test('treatAs collection forces a named-key record to be filtered', () => {
    const named = { alpha: { n: 1 }, beta: { n: 5 } }
    const result = applyQuery(named, { treatAs: 'collection', where: 'n > 2' })
    assert.equal(result.kind, 'object-map')
    assert.deepEqual(Object.keys(result.kind === 'object-map' ? result.items : {}), ['beta'])
  })

  test('reports an empty collection without erroring', () => {
    const result = applyQuery({}, {})
    assert.equal(result.kind, 'object-map')
    assert.equal(result.kind === 'object-map' ? result.total : -1, 0)
  })
})
