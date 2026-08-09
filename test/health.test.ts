import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, before, after } from 'node:test'

import { startMcpServer, defaultPortFile, type ServerHandle } from '../src/server.ts'
import store from './fixtures/store.json' with { type: 'json' }

describe('health endpoint', () => {
  let handle: ServerHandle

  before(async () => {
    handle = await startMcpServer({ getStore: () => store, port: 0, portFile: null })
  })

  after(async () => {
    await handle.close()
  })

  test('answers GET /health with ok', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/health`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'ok')
  })

  test('reports the port it is listening on', async () => {
    const body = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()
    assert.equal(body.port, handle.port)
  })

  test('identifies the server and version', async () => {
    const body = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()
    assert.equal(typeof body.name, 'string')
    assert.equal(typeof body.version, 'string')
  })

  test('reports the store as ready when game data is present', async () => {
    const body = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()
    assert.equal(body.storeReady, true)
  })

  test('sends no CORS header, so a web page cannot read it', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/health`)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })

  test('reports the store as not ready before the game loads', async () => {
    const empty = await startMcpServer({ getStore: () => ({}), port: 0, portFile: null })
    const body = await (await fetch(`http://127.0.0.1:${empty.port}/health`)).json()
    assert.equal(body.status, 'ok')
    assert.equal(body.storeReady, false)
    await empty.close()
  })

  test('stays ok when reading the store throws', async () => {
    const broken = await startMcpServer({
      getStore: () => {
        throw new Error('store exploded')
      },
      port: 0,
      portFile: null,
    })
    const response = await fetch(`http://127.0.0.1:${broken.port}/health`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.storeReady, false)
    await broken.close()
  })
})

describe('port file', () => {
  let directory: string

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'poi-game-mcp-test-'))
  })

  after(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('writes the listening port on start', async () => {
    const portFile = join(directory, 'write', 'port')
    const handle = await startMcpServer({ getStore: () => store, port: 0, portFile })
    try {
      assert.equal((await readFile(portFile, 'utf8')).trim(), String(handle.port))
    } finally {
      await handle.close()
    }
  })

  test('creates the containing directory', async () => {
    const portFile = join(directory, 'nested', 'deeper', 'port')
    const handle = await startMcpServer({ getStore: () => store, port: 0, portFile })
    try {
      assert.ok((await stat(portFile)).isFile())
    } finally {
      await handle.close()
    }
  })

  test('removes the file on close', async () => {
    const portFile = join(directory, 'removed', 'port')
    const handle = await startMcpServer({ getStore: () => store, port: 0, portFile })
    assert.ok((await stat(portFile)).isFile(), 'file should exist before close')
    await handle.close()
    await assert.rejects(() => readFile(portFile, 'utf8'))
  })

  test('writes the file readable only by the owner', async () => {
    const portFile = join(directory, 'perms', 'port')
    const handle = await startMcpServer({ getStore: () => store, port: 0, portFile })
    try {
      assert.equal((await stat(portFile)).mode & 0o777, 0o600)
    } finally {
      await handle.close()
    }
  })

  test('starts anyway when the port file cannot be written', async () => {
    // /dev/null is not a directory, so nothing can be created beneath it.
    const handle = await startMcpServer({
      getStore: () => store,
      port: 0,
      portFile: '/dev/null/port',
    })
    try {
      const body = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()
      assert.equal(body.status, 'ok')
    } finally {
      await handle.close()
    }
  })

  test('defaults to a path that does not collide with poi-plugin-mcp', () => {
    assert.match(defaultPortFile(), /\.poi-game-mcp[/\\]port$/)
    assert.doesNotMatch(defaultPortFile(), /\.poi-mcp[/\\]port$/)
  })
})
