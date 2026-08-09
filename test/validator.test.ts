import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { passthroughValidator } from '../src/validator.ts'

describe('passthroughValidator', () => {
  test('returns a validator function for a schema', () => {
    assert.equal(typeof passthroughValidator.getValidator({ type: 'object' }), 'function')
  })

  test('accepts input and hands it back unchanged', () => {
    const validate = passthroughValidator.getValidator({ type: 'object' })
    const input = { a: 1 }
    assert.deepEqual(validate(input), { valid: true, data: input, errorMessage: undefined })
  })

  test('is reusable across calls', () => {
    const validate = passthroughValidator.getValidator({ type: 'string' })
    assert.equal(validate('x').valid, true)
    assert.equal(validate('y').valid, true)
  })
})
