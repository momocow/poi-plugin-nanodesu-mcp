import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import pkg from '../package.json' with { type: 'json' }
import {
  CONFIG_PREFIX,
  PORT_CONFIG_KEY,
  RECENT_CONFIG_KEY,
  SCOPE_CONFIG_KEY,
} from '../src/config.ts'
import { NAMESPACE } from '../src/i18n.ts'

describe('config keys', () => {
  test('are namespaced by the plugin id poi knows it by', () => {
    assert.equal(CONFIG_PREFIX, `plugin.${pkg.poiPlugin.id}`)
  })

  test('share that namespace with the i18n translator', () => {
    assert.equal(NAMESPACE, pkg.poiPlugin.id)
  })

  test('all live under the prefix', () => {
    for (const key of [PORT_CONFIG_KEY, RECENT_CONFIG_KEY, SCOPE_CONFIG_KEY]) {
      assert.ok(key.startsWith(`${CONFIG_PREFIX}.`), `${key} is outside the namespace`)
    }
  })

  test('do not claim the protocol name, which another MCP plugin would take', () => {
    for (const key of [PORT_CONFIG_KEY, RECENT_CONFIG_KEY, SCOPE_CONFIG_KEY]) {
      assert.ok(!key.startsWith('plugin.mcp.'), `${key} is in the shared "mcp" namespace`)
    }
  })
})
