import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { test, describe, before, after } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { startMcpServer, type ServerHandle } from '../src/server.ts'
import store from './fixtures/store.json' with { type: 'json' }

type TextContent = { type: string; text: string }

const textOf = (result: unknown): string => {
  const content = (result as { content: TextContent[] }).content
  return content.map((c) => c.text).join('')
}

const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true

describe('mcp server over http', () => {
  let handle: ServerHandle
  let client: Client
  // Mutable so a test can prove reads are live rather than snapshotted.
  let current: unknown = store

  before(async () => {
    handle = await startMcpServer({ getStore: () => current, port: 0 })
    client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    )
  })

  after(async () => {
    await client.close()
    await handle.close()
  })

  test('binds to an ephemeral port and reports it', () => {
    assert.ok(handle.port > 0)
  })

  test('advertises exactly the three documented tools', async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['poi_describe', 'poi_get', 'poi_lookup'],
    )
  })

  test('describes each tool for the caller', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) {
      assert.ok((tool.description ?? '').length > 0, `${tool.name} needs a description`)
    }
  })

  test('poi_get returns store data as JSON', async () => {
    const result = await client.callTool({ name: 'poi_get', arguments: { path: 'info.basic' } })
    const data = JSON.parse(textOf(result))
    assert.equal(data.kind, 'object')
    assert.equal(data.value.api_level, 120)
  })

  test('poi_get filters over the wire', async () => {
    const result = await client.callTool({
      name: 'poi_get',
      arguments: {
        path: 'info.ships',
        where: 'api_nowhp < api_maxhp',
        select: ['api_id', 'api_nowhp', 'api_maxhp'],
      },
    })
    const data = JSON.parse(textOf(result))
    assert.equal(data.kind, 'object-map')
    assert.ok(data.returned > 0)
    for (const ship of Object.values(data.items) as Record<string, number>[]) {
      assert.ok(ship.api_nowhp! < ship.api_maxhp!)
    }
  })

  test('poi_lookup resolves master data by id', async () => {
    const shipId = Number(Object.keys(store.const.$ships)[0])
    const result = await client.callTool({
      name: 'poi_lookup',
      arguments: { kind: 'ships', ids: [shipId], select: ['api_name'] },
    })
    const data = JSON.parse(textOf(result))
    assert.equal(typeof data[String(shipId)].api_name, 'string')
  })

  test('poi_describe reports branch shape', async () => {
    const result = await client.callTool({ name: 'poi_describe', arguments: { path: 'info' } })
    const data = JSON.parse(textOf(result))
    assert.ok(data.keys.includes('ships'))
  })

  test('poi_describe works with no arguments', async () => {
    const result = await client.callTool({ name: 'poi_describe', arguments: {} })
    const data = JSON.parse(textOf(result))
    assert.ok(data.keys.includes('info'))
  })

  test('a denied path comes back as a tool error, not a crash', async () => {
    const result = await client.callTool({ name: 'poi_get', arguments: { path: 'layout' } })
    assert.equal(isError(result), true)
    assert.match(textOf(result), /layout/)
  })

  test('a bad where expression comes back as a tool error', async () => {
    const result = await client.callTool({
      name: 'poi_get',
      arguments: { path: 'info.ships', where: 'api_lv >' },
    })
    assert.equal(isError(result), true)
    assert.match(textOf(result), /position/i)
  })

  test('reads are live rather than snapshotted at startup', async () => {
    const before = JSON.parse(
      textOf(await client.callTool({ name: 'poi_get', arguments: { path: 'info.basic' } })),
    )
    assert.equal(before.value.api_level, 120)

    current = { ...store, info: { ...store.info, basic: { ...store.info.basic, api_level: 121 } } }

    const after = JSON.parse(
      textOf(await client.callTool({ name: 'poi_get', arguments: { path: 'info.basic' } })),
    )
    assert.equal(after.value.api_level, 121)

    current = store
  })

  test('a handler throwing does not take the server down', async () => {
    const thrower = await startMcpServer({
      getStore: () => {
        throw new Error('store exploded')
      },
      port: 0,
    })
    const throwClient = new Client({ name: 'test-client', version: '1.0.0' })
    await throwClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${thrower.port}/mcp`)),
    )

    const result = await throwClient.callTool({ name: 'poi_get', arguments: { path: 'info' } })
    assert.equal(isError(result), true)
    assert.match(textOf(result), /store exploded/)

    // Still responsive after the throw.
    const tools = await throwClient.listTools()
    assert.equal(tools.tools.length, 3)

    await throwClient.close()
    await thrower.close()
  })

  test('rejects a request whose Host header is not localhost', async () => {
    // node:http rather than fetch: undici will not let us override Host.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            host: 'evil.example.com',
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    })
    assert.ok(status >= 400, `expected a 4xx/5xx, got ${status}`)
  })

  test('returns 404 for paths other than the mcp endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/other`, { method: 'POST' })
    assert.equal(response.status, 404)
  })

  test('close stops the listener', async () => {
    const temporary = await startMcpServer({ getStore: () => store, port: 0 })
    const port = temporary.port
    await temporary.close()
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }))
  })

  test('reports a bind failure instead of throwing an unhandled error', async () => {
    const first = await startMcpServer({ getStore: () => store, port: 0 })
    await assert.rejects(
      () => startMcpServer({ getStore: () => store, port: first.port }),
      /EADDRINUSE|in use/i,
    )
    await first.close()
  })
})
