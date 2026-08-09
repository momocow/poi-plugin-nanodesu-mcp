import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { toJsonSafe, jsonByteLength, fitToBytes } from '../src/serialize.ts'
import type { QueryResult } from '../src/query.ts'

describe('toJsonSafe', () => {
  test('passes plain data through unchanged', () => {
    const value = { a: 1, b: 'x', c: [1, 2], d: null, e: true }
    assert.deepEqual(toJsonSafe(value), value)
  })

  test('drops function properties', () => {
    assert.deepEqual(toJsonSafe({ a: 1, fn: () => 1 }), { a: 1 })
  })

  test('drops functions from arrays by nulling the slot', () => {
    assert.deepEqual(toJsonSafe([1, () => 1]), [1, null])
  })

  test('replaces a self-reference with [Circular]', () => {
    const value: Record<string, unknown> = { name: 'a' }
    value.self = value
    assert.deepEqual(toJsonSafe(value), { name: 'a', self: '[Circular]' })
  })

  test('replaces a mutual reference cycle with [Circular]', () => {
    const a: Record<string, unknown> = { name: 'a' }
    const b: Record<string, unknown> = { name: 'b', a }
    a.b = b
    assert.deepEqual(toJsonSafe(a), { name: 'a', b: { name: 'b', a: '[Circular]' } })
  })

  test('survives a cycle inside an array', () => {
    const items: unknown[] = [1]
    items.push(items)
    assert.deepEqual(toJsonSafe(items), [1, '[Circular]'])
  })

  test('repeats a shared non-circular value rather than calling it circular', () => {
    const shared = { n: 1 }
    assert.deepEqual(toJsonSafe({ a: shared, b: shared }), { a: { n: 1 }, b: { n: 1 } })
  })

  test('caps depth', () => {
    assert.deepEqual(toJsonSafe({ a: { b: { c: { d: 1 } } } }, 2), { a: { b: '[MaxDepth]' } })
  })

  test('leaves values within the depth cap intact', () => {
    assert.deepEqual(toJsonSafe({ a: { b: 1 } }, 2), { a: { b: 1 } })
  })

  test('produces something JSON.stringify accepts for a cyclic graph', () => {
    const node: Record<string, unknown> = { tag: 'div' }
    node.parent = node
    assert.doesNotThrow(() => JSON.stringify(toJsonSafe(node)))
  })
})

describe('jsonByteLength', () => {
  test('counts bytes of a simple value', () => {
    assert.equal(jsonByteLength({ a: 1 }), Buffer.byteLength('{"a":1}', 'utf8'))
  })

  test('counts multi-byte characters as their utf-8 length', () => {
    // "長鯨" is 3 bytes per character, not 1
    assert.equal(jsonByteLength('長鯨'), Buffer.byteLength('"長鯨"', 'utf8'))
    assert.ok(jsonByteLength('長鯨') > 4)
  })
})

describe('fitToBytes', () => {
  const mapResult = (count: number): QueryResult => {
    const items: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
      items[String(i)] = { api_id: i, filler: 'x'.repeat(100) }
    }
    return { kind: 'object-map', total: count, returned: count, truncated: false, items }
  }

  test('returns a small result unchanged', () => {
    const result = fitToBytes(mapResult(2), 65536)
    assert.equal(result.ok, true)
    assert.equal(result.ok === true && result.payload.kind === 'object-map', true)
    if (result.ok && result.payload.kind === 'object-map') {
      assert.equal(result.payload.returned, 2)
      assert.equal(result.payload.truncated, false)
    }
  })

  test('drops object-map entries until the result fits', () => {
    const result = fitToBytes(mapResult(100), 1000)
    assert.equal(result.ok, true)
    if (result.ok && result.payload.kind === 'object-map') {
      assert.ok(result.payload.returned < 100)
      assert.equal(result.payload.truncated, true)
      assert.ok(jsonByteLength(result.payload) <= 1000)
    }
  })

  test('preserves total when truncating', () => {
    const result = fitToBytes(mapResult(100), 1000)
    if (result.ok && result.payload.kind === 'object-map') {
      assert.equal(result.payload.total, 100)
    }
  })

  test('keeps the first entries when truncating', () => {
    const result = fitToBytes(mapResult(100), 1000)
    if (result.ok && result.payload.kind === 'object-map') {
      assert.equal(Object.keys(result.payload.items)[0], '0')
    }
  })

  test('drops array items until the result fits', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, filler: 'x'.repeat(100) }))
    const source: QueryResult = {
      kind: 'array',
      total: 100,
      returned: 100,
      truncated: false,
      items,
    }
    const result = fitToBytes(source, 1000)
    assert.equal(result.ok, true)
    if (result.ok && result.payload.kind === 'array') {
      assert.ok(result.payload.items.length < 100)
      assert.equal(result.payload.truncated, true)
      assert.ok(jsonByteLength(result.payload) <= 1000)
    }
  })

  test('keeps truncated true when the query already truncated by limit', () => {
    const source = { ...mapResult(2), truncated: true, total: 500 } as QueryResult
    const result = fitToBytes(source, 65536)
    if (result.ok && result.payload.kind === 'object-map') {
      assert.equal(result.payload.truncated, true)
    }
  })

  test('returns zero entries rather than erroring when even one will not fit', () => {
    const result = fitToBytes(mapResult(10), 60)
    assert.equal(result.ok, true)
    if (result.ok && result.payload.kind === 'object-map') {
      assert.equal(result.payload.returned, 0)
      assert.equal(result.payload.truncated, true)
    }
  })

  test('errors when an object value exceeds the cap', () => {
    const source: QueryResult = { kind: 'object', value: { filler: 'x'.repeat(5000) } }
    const result = fitToBytes(source, 1000)
    assert.equal(result.ok, false)
    assert.match(result.ok === false ? result.error : '', /select|narrower/i)
  })

  test('reports the actual size when a value exceeds the cap', () => {
    const source: QueryResult = { kind: 'object', value: { filler: 'x'.repeat(5000) } }
    const result = fitToBytes(source, 1000)
    assert.match(result.ok === false ? result.error : '', /5\d{3}/)
  })

  test('errors when a scalar exceeds the cap', () => {
    const source: QueryResult = { kind: 'scalar', value: 'x'.repeat(5000) }
    const result = fitToBytes(source, 1000)
    assert.equal(result.ok, false)
  })

  test('passes a value through when it fits', () => {
    const source: QueryResult = { kind: 'object', value: { a: 1 } }
    const result = fitToBytes(source, 1000)
    assert.equal(result.ok, true)
    if (result.ok && result.payload.kind === 'object') {
      assert.deepEqual(result.payload.value, { a: 1 })
    }
  })

  test('makes a cyclic value safe rather than throwing', () => {
    const value: Record<string, unknown> = { tag: 'div' }
    value.self = value
    const result = fitToBytes({ kind: 'object', value }, 65536)
    assert.equal(result.ok, true)
    if (result.ok && result.payload.kind === 'object') {
      assert.deepEqual(result.payload.value, { tag: 'div', self: '[Circular]' })
    }
  })
})
