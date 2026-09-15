import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { test, describe, before, after } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { startMcpServer, type ServerHandle, type ServerStatus } from '../src/server.ts'
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
    handle = await startMcpServer({ getStore: () => current, port: 0, portFile: null })
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

  test('advertises exactly the four documented tools', async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['poi_battle', 'poi_describe', 'poi_get', 'poi_lookup'],
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
      portFile: null,
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
    assert.equal(tools.tools.length, 4)

    await throwClient.close()
    await thrower.close()
  })

  test('poi_battle reads a record through the injected reader', async () => {
    const record = { fleet: { main: [{ api_ship_id: 507 }, { api_ship_id: 560 }] } }
    const withBattles = await startMcpServer({
      getStore: () => store,
      readBattle: () => record,
      port: 0,
      portFile: null,
    })
    const battleClient = new Client({ name: 'test-client', version: '1.0.0' })
    try {
      await battleClient.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${withBattles.port}/mcp`)),
      )
      const result = await battleClient.callTool({
        name: 'poi_battle',
        arguments: { ids: [1789232781382], select: ['fleet.main[].api_ship_id'] },
      })
      const data = JSON.parse(textOf(result))
      assert.deepEqual(data.items['1789232781382'], {
        'fleet.main[].api_ship_id': [507, 560],
      })
    } finally {
      // Always, so a failed assertion cannot leave the loop holding a socket.
      await battleClient.close()
      await withBattles.close()
    }
  })

  test('poi_battle says so when there is no reader rather than failing the call', async () => {
    const result = await client.callTool({ name: 'poi_battle', arguments: { ids: [1] } })
    assert.equal(isError(result), true)
    assert.match(textOf(result), /not available/i)
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
    const temporary = await startMcpServer({ getStore: () => store, port: 0, portFile: null })
    const port = temporary.port
    await temporary.close()
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }))
  })

  test('reports a bind failure instead of throwing an unhandled error', async () => {
    const first = await startMcpServer({ getStore: () => store, port: 0, portFile: null })
    await assert.rejects(
      () => startMcpServer({ getStore: () => store, port: first.port, portFile: null }),
      /EADDRINUSE|in use/i,
    )
    await first.close()
  })
})

describe('status reporting', () => {
  test('logs each request for the status panel', async () => {
    const seen: ServerStatus[] = []
    const handle = await startMcpServer({
      getStore: () => store,
      port: 0,
      portFile: null,
      onStatus: (status) => seen.push(status),
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    )
    await client.callTool({ name: 'poi_get', arguments: { path: 'info.basic' } })
    await client.close()
    await handle.close()

    const recent = seen.at(-1)?.recent ?? []
    assert.deepEqual(
      { tool: recent[0]?.tool, detail: recent[0]?.detail },
      { tool: 'poi_get', detail: 'info.basic' },
      'the newest entry should be the tool call',
    )
    assert.ok(
      recent.some((entry) => entry.method === 'initialize'),
      'the handshake should be logged too',
    )
    assert.ok((recent[0]?.at ?? 0) > 0)
  })
})

describe('request log limit', () => {
  test('keeps only the configured number of entries, oldest out first', async () => {
    const seen: ServerStatus[] = []
    const handle = await startMcpServer({
      getStore: () => store,
      port: 0,
      portFile: null,
      recentLimit: 2,
      onStatus: (status) => seen.push(status),
    })
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    )
    await client.callTool({ name: 'poi_get', arguments: { path: 'info.basic' } })
    await client.callTool({ name: 'poi_get', arguments: { path: 'info.resources' } })
    await client.close()
    await handle.close()

    const recent = seen.at(-1)?.recent ?? []
    assert.equal(recent.length, 2)
    assert.deepEqual(
      recent.map((entry) => entry.detail),
      ['info.resources', 'info.basic'],
      'the handshake entries should have aged out',
    )
  })
})
