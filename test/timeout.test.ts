import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { withTimeout } from '../src/timeout.ts'

describe('withTimeout', () => {
  test('resolves with the value when the promise settles in time', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'too slow'), 'ok')
  })

  test('propagates a rejection unchanged', async () => {
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error('boom')), 1000, 'too slow'),
      /boom/,
    )
  })

  test('rejects with the given message when the promise never settles', async () => {
    await assert.rejects(() => withTimeout(new Promise(() => {}), 20, 'too slow'), /too slow/)
  })

  test('does not keep the process alive after resolving', async () => {
    // An un-cleared timer would hold the event loop open. If the timer is
    // cleared, this test simply completes.
    await withTimeout(Promise.resolve(1), 60_000, 'too slow')
  })

  test('does not keep the process alive after rejecting', async () => {
    await assert.rejects(() => withTimeout(Promise.reject(new Error('x')), 60_000, 'too slow'))
  })
})
