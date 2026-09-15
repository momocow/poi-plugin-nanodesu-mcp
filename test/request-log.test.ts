import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  appendRequest,
  describeRequest,
  DEFAULT_RECENT_LIMIT,
  type RequestLogEntry,
} from '../src/request-log.ts'

describe('describeRequest', () => {
  test('logs the method of a plain request', () => {
    assert.deepEqual(describeRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 5), {
      at: 5,
      method: 'initialize',
    })
  })

  test('names the tool of a tools/call', () => {
    const entry = describeRequest(
      { method: 'tools/call', params: { name: 'poi_get', arguments: { path: 'info.basic' } } },
      5,
    )
    assert.deepEqual(entry, { at: 5, method: 'tools/call', tool: 'poi_get', detail: 'info.basic' })
  })

  test('summarizes a lookup by its kind', () => {
    const entry = describeRequest(
      { method: 'tools/call', params: { name: 'poi_lookup', arguments: { kind: 'ships', ids: [1] } } },
      5,
    )
    assert.equal(entry?.detail, 'ships')
  })

  test('summarizes an id-only call by how many ids it asked for', () => {
    const entry = describeRequest(
      { method: 'tools/call', params: { name: 'poi_battle', arguments: { ids: [1, 2, 3] } } },
      5,
    )
    assert.equal(entry?.detail, '3 ids')
  })

  test('leaves the detail out when there is no argument worth showing', () => {
    const entry = describeRequest({ method: 'tools/call', params: { name: 'poi_describe' } }, 5)
    assert.deepEqual(entry, { at: 5, method: 'tools/call', tool: 'poi_describe' })
  })

  test('does not treat a tool name on another method as a tool call', () => {
    const entry = describeRequest({ method: 'tools/list', params: { name: 'poi_get' } }, 5)
    assert.deepEqual(entry, { at: 5, method: 'tools/list' })
  })

  test('ignores anything that is not a request', () => {
    for (const message of [{ jsonrpc: '2.0', id: 1, result: {} }, { method: '' }, null, 'nope', 7]) {
      assert.equal(
        describeRequest(message, 5),
        undefined,
        `expected no entry for ${JSON.stringify(message)}`,
      )
    }
  })
})

describe('appendRequest', () => {
  const entry = (at: number): RequestLogEntry => ({ at, method: 'tools/call' })

  test('puts the newest entry first', () => {
    const recent = appendRequest(appendRequest([], entry(1)), entry(2))
    assert.deepEqual(
      recent.map((e) => e.at),
      [2, 1],
    )
  })

  test('does not mutate the log it was given', () => {
    const before: RequestLogEntry[] = [entry(1)]
    appendRequest(before, entry(2))
    assert.equal(before.length, 1)
  })

  test('honours a configured limit, dropping the oldest first', () => {
    let recent: RequestLogEntry[] = []
    for (const at of [1, 2, 3]) {
      recent = appendRequest(recent, entry(at), 2)
    }
    assert.deepEqual(
      recent.map((e) => e.at),
      [3, 2],
    )
  })

  test('keeps nothing when the limit is zero', () => {
    assert.deepEqual(appendRequest([entry(1)], entry(2), 0), [])
  })

  test('drops the oldest entries past the default cap', () => {
    let recent: RequestLogEntry[] = []
    for (let at = 0; at <= DEFAULT_RECENT_LIMIT; at += 1) {
      recent = appendRequest(recent, entry(at))
    }
    assert.equal(recent.length, DEFAULT_RECENT_LIMIT)
    assert.equal(recent[0]?.at, DEFAULT_RECENT_LIMIT)
    assert.equal(recent.at(-1)?.at, 1)
  })
})
