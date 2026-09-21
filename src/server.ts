import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { type ReadBattle } from './battles.ts'
import { HENSEI_DATA_PATH, type HenseiCalc } from './hensei.ts'
import {
  appendRequest,
  describeRequest,
  DEFAULT_RECENT_LIMIT,
  type RequestLogEntry,
} from './request-log.ts'
import {
  LOOKUP_KINDS,
  poiBattle,
  poiDescribe,
  poiGet,
  poiHenseiSave,
  poiLookup,
  type HenseiSaveArgs,
  type ToolResult,
  DEFAULT_LIMIT,
  DEFAULT_MAX_BYTES,
  MAX_BATTLE_IDS,
  MAX_DECKS,
  MAX_LOOKUP_IDS,
  MAX_MAX_BYTES,
} from './tools.ts'
import { passthroughValidator } from './validator.ts'

export const SERVER_NAME = 'poi-nanodesu-mcp'
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
export const defaultPortFile = (): string => join(homedir(), '.poi-nanodesu-mcp', 'port')

export type ServerStatus = {
  state: 'stopped' | 'listening' | 'error'
  port?: number
  error?: string
  lastRequestAt?: number
  requestCount: number
  /** Newest first, capped. See src/request-log.ts. */
  recent: RequestLogEntry[]
}

export type ServerOptions = {
  getStore: () => unknown
  /** Reads one saved battle record by id. Omitted when there is none to read. */
  readBattle?: ReadBattle
  /**
   * poi's store dispatch, and poi-plugin-hensei-nikki's fleet conversion.
   *
   * Both are required before poi_hensei_save — the only tool that writes — is
   * registered at all, so a server given neither is read-only, and that is the
   * default rather than something to be configured.
   */
  dispatch?: (action: unknown) => void
  hensei?: HenseiCalc
  port: number
  host?: string
  onStatus?: (status: ServerStatus) => void
  /** Path to publish the listening port to. `null` disables it. */
  portFile?: string | null
  /** How many request-log entries to keep (default DEFAULT_RECENT_LIMIT). */
  recentLimit?: number
}

export type ServerHandle = {
  port: number
  close: () => Promise<void>
}

/**
 * The SDK is loaded with `require` first, falling back to dynamic `import()`.
 *
 * The original design had this the other way round, on the assumption that the
 * SDK was ESM-only and that a native `import()` was the robust choice. Both
 * halves were wrong. SDK 1.30 is dual-published, so `require` resolves its CJS
 * build; and in poi's renderer — a `file://` page under a script-src CSP — the
 * native `import()` never settles. It does not reject, so nothing is logged and
 * nothing can catch it: the plugin just sits at "stopped" forever.
 *
 * `require` is also simply the right call in poi, whose whole plugin system is
 * CJS. The import fallback remains for a future ESM-only SDK.
 */
type Sdk = {
  McpServer: typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
  StreamableHTTPServerTransport: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport
}

declare const require: ((id: string) => unknown) | undefined

const MCP_MODULE = '@modelcontextprotocol/sdk/server/mcp.js'
const HTTP_MODULE = '@modelcontextprotocol/sdk/server/streamableHttp.js'

const asSdk = (mcp: unknown, http: unknown): Sdk | undefined => {
  const McpServer = (mcp as Partial<Sdk> | undefined)?.McpServer
  const StreamableHTTPServerTransport = (http as Partial<Sdk> | undefined)
    ?.StreamableHTTPServerTransport
  return McpServer && StreamableHTTPServerTransport
    ? { McpServer, StreamableHTTPServerTransport }
    : undefined
}

let sdkPromise: Promise<Sdk> | undefined

const loadSdk = (): Promise<Sdk> => {
  sdkPromise ??= (async () => {
    if (typeof require === 'function') {
      try {
        const viaRequire = asSdk(require(MCP_MODULE), require(HTTP_MODULE))
        if (viaRequire) {
          return viaRequire
        }
      } catch {
        // Fall through to import() — the SDK may be ESM-only.
      }
    }

    const [mcp, http] = await Promise.all([import(MCP_MODULE), import(HTTP_MODULE)])
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
const adaptPure =
  <A>(handler: (args: A) => ToolResult<unknown>) =>
  async (args: A) => {
    try {
      const result = handler(args)
      return result.ok ? textResult(JSON.stringify(result.data)) : textResult(result.error, true)
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true)
    }
  }

const adapt = <A>(
  getStore: () => unknown,
  handler: (store: unknown, args: A) => ToolResult<unknown>,
) => adaptPure<A>((args) => handler(getStore(), args))

async function buildMcpServer(options: ServerOptions): Promise<McpServer> {
  const { getStore, readBattle } = options
  const { McpServer: Server } = await loadSdk()
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // Keeps the SDK from constructing its Ajv validator, which breaks inside
    // poi. See the comment on passthroughValidator.
    { jsonSchemaValidator: passthroughValidator },
  )

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
              '(array membership, or substring when both sides are strings) ' +
              'exists. Fields may be nested or indexed (api_exp[0]), and a row that is itself ' +
              'an array is addressed by position ([0], [1]). ' +
              'Examples: "api_nowhp < api_maxhp", "api_lv >= 99 and api_locked = 1", ' +
              '"api_ship_id in [487, 213]", "api_sally_area exists". ' +
              'Chinese text must be quoted, and the glyph form matters: questline.quests is ' +
              'Simplified (category = "出击"), while ext.poi-plugin-battle-detail indexes are ' +
              'Traditional ("出擊"). The wrong form matches nothing and does not error.',
          ),
        select: z
          .array(z.string())
          .optional()
          .describe(
            'Fieldpaths to keep. The path string is used as the output key. `[]` maps over an ' +
              'array rather than indexing it, so "api_ship[].api_lv" keeps one level per ship.',
          ),
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
          .describe(
            'Which master table to read. Each table has its own id space: useitems ids in ' +
              'particular are unrelated to the positions of info.resources, and order ' +
              'instant-repair and instant-build the other way round, so an id from one is a ' +
              'valid-looking wrong answer in the other.',
          ),
        ids: z.array(z.number()).describe('The ids to resolve. Ids not present are omitted.'),
        select: z.array(z.string()).optional().describe('Fieldpaths to keep from each record.'),
      },
    },
    adapt(getStore, poiLookup),
  )

  server.registerTool(
    'poi_battle',
    {
      title: 'Read saved battle records',
      description:
        'Read whole battle records saved by poi-plugin-battle-detail, by id. Ids come from ' +
        'that plugin\'s index at "ext.poi-plugin-battle-detail._.indexes", which holds one row ' +
        'per battle (id, time_, map, route, rank) — filter that for the battles you want, then ' +
        'pass their ids here. A record holds what the index cannot: fleet.main / fleet.escort ' +
        'with each ship\'s api_ship_id, api_lv, api_kyouka and poi_slot equipment, plus the ' +
        'raw battle packet and its result. Resolve ship and equipment ids with poi_lookup. ' +
        `A whole record is ~22 KB, so use select: "fleet.main[].api_ship_id" costs a few ` +
        `hundred bytes where the whole fleet costs 18 KB. At most ${MAX_BATTLE_IDS} ids per call.`,
      inputSchema: {
        ids: z
          .array(z.number())
          .describe('Battle ids, as found in ext.poi-plugin-battle-detail._.indexes.'),
        select: z
          .array(z.string())
          .optional()
          .describe(
            'Fieldpaths to keep, e.g. "fleet.main[].api_ship_id", "fleet.main[].poi_slot[].api_name". ' +
              'The path string is used as the output key.',
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Serialized size cap (default ${DEFAULT_MAX_BYTES}, maximum ${MAX_MAX_BYTES}). ` +
              'Records are dropped from the end until the response fits.',
          ),
      },
    },
    adaptPure((args: Parameters<typeof poiBattle>[1]) => poiBattle(readBattle, args)),
  )

  server.registerTool(
    'poi_describe',
    {
      title: 'Describe a poi store branch',
      description:
        'Discover what is available at a store path: its kind, element count, keys, and the ' +
        'field names of a sample element. Call with no path to list the readable paths. ' +
        'Use this before poi_get rather than guessing at paths or field names. ' +
        'For paths whose rows are positional arrays (info.resources, the akashic-records logs) ' +
        'it returns the real column names in place of "0", "1", ... , and a note where a field ' +
        'means something here that it does not mean elsewhere. For a log whose rows carry a ' +
        'timestamp it also returns timeRange: the oldest and newest instant the branch actually ' +
        'holds, as stored (min/max) and as UTC ISO (from/to). Beware that the store mixes ' +
        'clocks: the game\'s own api_*_time_str strings are JST, some plugins format theirs in ' +
        'the host timezone, and none of those strings carries a marker — compare on epochs, not ' +
        'on strings. Read timeRange before concluding anything from an empty ' +
        'result — outside that range a filter matches nothing because the data does not reach ' +
        'that far, which is not the same as nothing having happened.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Dot path to describe. Omit to list the readable store paths.'),
      },
    },
    adapt(getStore, poiDescribe),
  )

  // The one tool that writes, and only when there is something to write with.
  // Left unregistered otherwise so a client is never offered a save that
  // cannot happen.
  const { dispatch, hensei } = options
  if (dispatch !== undefined && hensei !== undefined) {
    server.registerTool(
      'poi_hensei_save',
      {
        title: 'Save a fleet record to 編成日記',
        description:
          'Save a fleet composition as a record in the poi-plugin-hensei-nikki (編成日記) ' +
          'plugin. This is the only tool here that changes anything: it adds the record to ' +
          "poi's live state, and that plugin writes it to disk immediately. " +
          `Pass decks to save the fleets the account currently has (1-${MAX_DECKS}, as ` +
          'numbered in poi), or code to import a composition — a deckbuilder v4 object, a ' +
          "poi-h-v1 record, or one of that plugin's legacy encodings. " +
          `Existing records are at ${HENSEI_DATA_PATH}; read them with poi_get to see what ` +
          'titles are taken.',
        inputSchema: {
          title: z
            .string()
            .describe(
              'The record title, which is also its key: a title already in use is refused ' +
                'unless overwrite is set.',
            ),
          note: z.string().optional().describe('Free-text note stored alongside the fleets.'),
          decks: z
            .array(z.number().int())
            .optional()
            .describe(
              `Deck numbers to save, 1-${MAX_DECKS}, e.g. [1] for the first fleet or [1, 2] ` +
                'for a combined one. Mutually exclusive with code.',
            ),
          code: z
            .unknown()
            .optional()
            .describe(
              'A composition to import instead of reading the live fleets. Mutually ' +
                'exclusive with decks.',
            ),
          overwrite: z
            .boolean()
            .optional()
            .describe(
              'Replace an existing record of the same title. The old composition is gone for ' +
                'good — read it first if it might matter.',
            ),
        },
      },
      adaptPure((args: HenseiSaveArgs) =>
        poiHenseiSave({ store: getStore(), dispatch, calc: hensei }, args),
      ),
    )
  }

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
  const recentLimit = Math.max(0, options.recentLimit ?? DEFAULT_RECENT_LIMIT)
  const { StreamableHTTPServerTransport } = await loadSdk()

  const status: ServerStatus = { state: 'stopped', requestCount: 0, recent: [] }
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

    // A batch is several requests in one POST, so each gets its own entry.
    for (const message of Array.isArray(body) ? body : [body]) {
      const entry = describeRequest(message, status.lastRequestAt ?? Date.now())
      if (entry !== undefined) {
        status.recent = appendRequest(status.recent, entry, recentLimit)
      }
    }
    report()

    // Stateless: a fresh server and transport per request. These tools are
    // read-only with no subscriptions, so there is no session state worth
    // keeping, and nothing survives a plugin reload.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
    })
    const mcp = await buildMcpServer(options)

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
      console.error('[poi-plugin-nanodesu-mcp] request failed:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
      }
      // The stack goes in the body too. This server is loopback-only with no
      // CORS, and a request that fails inside poi is otherwise very hard to
      // diagnose from outside the renderer.
      res.end(e instanceof Error ? (e.stack ?? e.message) : 'internal error')
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
          console.warn('[poi-plugin-nanodesu-mcp] could not write the port file:', e)
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
