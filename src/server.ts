import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import {
  LOOKUP_KINDS,
  poiDescribe,
  poiGet,
  poiLookup,
  type ToolResult,
  DEFAULT_LIMIT,
  DEFAULT_MAX_BYTES,
  MAX_LOOKUP_IDS,
  MAX_MAX_BYTES,
} from './tools.ts'

export const SERVER_NAME = 'poi-game-mcp'
export const SERVER_VERSION = '0.1.0'
export const DEFAULT_PORT = 12450

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Where the listening port is published for clients that need to discover it.
 *
 * Deliberately not `~/.poi-mcp/port`: that belongs to the unrelated
 * `poi-plugin-mcp` package, and both plugins should be able to run at once
 * without overwriting each other's file.
 */
export const defaultPortFile = (): string => join(homedir(), '.poi-game-mcp', 'port')

export type ServerStatus = {
  state: 'stopped' | 'listening' | 'error'
  port?: number
  error?: string
  lastRequestAt?: number
  requestCount: number
}

export type ServerOptions = {
  getStore: () => unknown
  port: number
  host?: string
  onStatus?: (status: ServerStatus) => void
  /** Path to publish the listening port to. `null` disables it. */
  portFile?: string | null
}

export type ServerHandle = {
  port: number
  close: () => Promise<void>
}

/**
 * The SDK is loaded through a dynamic `import()`, which poi's babel config
 * keeps native (see the supportsDynamicImport note in poi's babel-hook.js).
 *
 * SDK 1.30 is dual-published, so a static import would also resolve today —
 * babel would rewrite it to `require` and find the CJS build. The dynamic form
 * is resolution-agnostic: it keeps working if the SDK goes ESM-only, which is
 * the case a plain `require` cannot survive.
 */
type Sdk = {
  McpServer: typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
  StreamableHTTPServerTransport: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport
}

let sdkPromise: Promise<Sdk> | undefined

const loadSdk = (): Promise<Sdk> => {
  sdkPromise ??= (async () => {
    const [mcp, http] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ])
    return {
      McpServer: mcp.McpServer,
      StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
    }
  })()
  return sdkPromise
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
})

/**
 * Adapt a pure tool handler to MCP. Every failure path — a refused query, a
 * throwing store, a bug in a handler — becomes an error *result* rather than a
 * rejected promise, so a bad call can never take the renderer down with it.
 */
const adapt =
  <A>(getStore: () => unknown, handler: (store: unknown, args: A) => ToolResult<unknown>) =>
  async (args: A) => {
    try {
      const result = handler(getStore(), args)
      return result.ok ? textResult(JSON.stringify(result.data)) : textResult(result.error, true)
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true)
    }
  }

async function buildMcpServer(getStore: () => unknown): Promise<McpServer> {
  const { McpServer: Server } = await loadSdk()
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION })

  server.registerTool(
    'poi_get',
    {
      title: 'Read poi store',
      description:
        'Read live game state from the running poi instance. `path` is a dot path into the ' +
        'redux store, e.g. "info.ships", "info.fleets", "info.basic", "info.resources". ' +
        'Returns raw kcsapi data — resolve ids to names with poi_lookup. ' +
        'Collections (arrays, or objects keyed by id) support `where`, `select`, and `limit`; ' +
        'single records support `select`. Use poi_describe first if you are unsure of a path ' +
        'or field name.',
      inputSchema: {
        path: z.string().describe('Dot path into the store, e.g. "info.ships"'),
        where: z
          .string()
          .optional()
          .describe(
            'Filter expression over each element. Grammar: <field> <op> <value|field>, ' +
              'combined with and/or/not and parentheses. Ops: = == != < <= > >= in contains ' +
              'exists. Fields may be nested or indexed (api_exp[0]). ' +
              'Examples: "api_nowhp < api_maxhp", "api_lv >= 99 and api_locked = 1", ' +
              '"api_ship_id in [487, 213]", "api_sally_area exists".',
          ),
        select: z
          .array(z.string())
          .optional()
          .describe('Fieldpaths to keep. The path string is used as the output key.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum elements to return (default ${DEFAULT_LIMIT}).`),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Serialized size cap (default ${DEFAULT_MAX_BYTES}, maximum ${MAX_MAX_BYTES}). ` +
              'Collections are truncated to fit; a single oversized record is an error.',
          ),
        treatAs: z
          .enum(['collection', 'value'])
          .optional()
          .describe(
            'Override how the value is interpreted. By default an array, or an object whose ' +
              'keys are all integer-like, is a collection; anything else is a single value.',
          ),
      },
    },
    adapt(getStore, poiGet),
  )

  server.registerTool(
    'poi_lookup',
    {
      title: 'Look up poi master data',
      description:
        'Resolve master-data ids to their records — this is how you turn api_ship_id into a ' +
        'ship name, or api_slotitem_id into an equipment name. ' +
        `ids is required and capped at ${MAX_LOOKUP_IDS} per call, because these tables are ` +
        'large (const.$ships alone is ~1.6 MB).',
      inputSchema: {
        kind: z
          .enum(Object.keys(LOOKUP_KINDS) as [string, ...string[]])
          .describe('Which master table to read.'),
        ids: z.array(z.number()).describe('The ids to resolve. Ids not present are omitted.'),
        select: z.array(z.string()).optional().describe('Fieldpaths to keep from each record.'),
      },
    },
    adapt(getStore, poiLookup),
  )

  server.registerTool(
    'poi_describe',
    {
      title: 'Describe a poi store branch',
      description:
        'Discover what is available at a store path: its kind, element count, keys, and the ' +
        'field names of a sample element. Call with no path to list the readable roots. ' +
        'Use this before poi_get rather than guessing at paths or field names.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Dot path to describe. Omit to list the readable store roots.'),
      },
    },
    adapt(getStore, poiDescribe),
  )

  return server
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

export async function startMcpServer(options: ServerOptions): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const { StreamableHTTPServerTransport } = await loadSdk()

  const status: ServerStatus = { state: 'stopped', requestCount: 0 }
  const report = () => options.onStatus?.({ ...status })

  const storeReady = (): boolean => {
    try {
      const store = options.getStore()
      return store !== null && typeof store === 'object' && 'info' in store
    } catch {
      return false
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, port: number) => {
    const path = (req.url ?? '').split('?')[0]

    // No CORS headers anywhere, deliberately: without them a web page cannot
    // read these responses cross-origin.
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(
        JSON.stringify({
          status: 'ok',
          name: SERVER_NAME,
          version: SERVER_VERSION,
          port,
          storeReady: storeReady(),
        }),
      )
      return
    }

    if (req.method !== 'POST' || path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    status.requestCount += 1
    status.lastRequestAt = Date.now()
    report()

    const raw = await readBody(req)
    let body: unknown
    try {
      body = raw.length > 0 ? JSON.parse(raw) : undefined
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      )
      return
    }

    // Stateless: a fresh server and transport per request. These tools are
    // read-only with no subscriptions, so there is no session state worth
    // keeping, and nothing survives a plugin reload.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
    })
    const mcp = await buildMcpServer(options.getStore)

    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })

    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const httpServer = createServer((req, res) => {
    const address = httpServer.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    handle(req, res, port).catch((e: unknown) => {
      // Never let a request failure escape into the renderer.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
      }
      res.end(e instanceof Error ? e.message : 'internal error')
    })
  })

  return await new Promise<ServerHandle>((resolve, reject) => {
    const onListenError = (e: NodeJS.ErrnoException) => {
      status.state = 'error'
      status.error = e.code === 'EADDRINUSE' ? `port ${options.port} is already in use` : e.message
      report()
      reject(e)
    }

    httpServer.once('error', onListenError)

    httpServer.listen(options.port, host, () => {
      httpServer.removeListener('error', onListenError)
      // Past startup, a socket error must not crash the renderer.
      httpServer.on('error', (e) => {
        status.state = 'error'
        status.error = e.message
        report()
      })

      const address = httpServer.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port

      const portFile = options.portFile === undefined ? defaultPortFile() : options.portFile
      if (portFile !== null) {
        // Publishing the port is a convenience, never a reason to fail startup.
        try {
          mkdirSync(dirname(portFile), { recursive: true, mode: 0o700 })
          writeFileSync(portFile, `${port}\n`, { encoding: 'utf8', mode: 0o600 })
        } catch (e) {
          console.warn('[poi-plugin-game-mcp] could not write the port file:', e)
        }
      }

      status.state = 'listening'
      status.port = port
      delete status.error
      report()

      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            if (portFile !== null) {
              try {
                unlinkSync(portFile)
              } catch {
                // Already gone, or never written. Either way there is nothing to do.
              }
            }
            httpServer.close(() => {
              status.state = 'stopped'
              report()
              done()
            })
            httpServer.closeAllConnections?.()
          }),
      })
    })
  })
}
