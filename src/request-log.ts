/**
 * A small in-memory log of what clients have asked for, so the status panel can
 * show that the server is actually being used, and for what.
 *
 * Deliberately not attributed to a client. MCP carries the caller's identity
 * only in `initialize`'s `clientInfo`, and this server is stateless — a fresh
 * McpServer per request, no session id — so there is nothing to tie that
 * identity to the tool calls that follow. An entry says what was asked, not
 * who asked.
 *
 * Deliberately not persisted either: it describes this run of the server.
 */

/**
 * How many entries to keep unless poi's config says otherwise. Only a default:
 * the config may ask for more, and an entry is a few short strings.
 */
export const DEFAULT_RECENT_LIMIT = 100

export type RequestLogEntry = {
  at: number
  /** JSON-RPC method, e.g. "tools/call", "initialize". */
  method: string
  /** Tool name, for a tools/call. */
  tool?: string
  /** The one argument worth showing at a glance, e.g. the path read. */
  detail?: string
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const summarizeArguments = (args: unknown): string | undefined => {
  const record = asRecord(args)
  if (record === undefined) {
    return undefined
  }

  for (const key of ['path', 'kind']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  return Array.isArray(record.ids) ? `${record.ids.length} ids` : undefined
}

/**
 * One log entry per JSON-RPC *request*. Anything without a method — a
 * response, or a body that is not a message at all — is not a request and is
 * not logged.
 */
export function describeRequest(message: unknown, at: number): RequestLogEntry | undefined {
  const record = asRecord(message)
  const method = record?.method
  if (typeof method !== 'string' || method.length === 0) {
    return undefined
  }

  const params = asRecord(record?.params)
  const name = params?.name
  const tool = method === 'tools/call' && typeof name === 'string' ? name : undefined
  const detail = tool === undefined ? undefined : summarizeArguments(params?.arguments)

  return {
    at,
    method,
    ...(tool === undefined ? {} : { tool }),
    ...(detail === undefined ? {} : { detail }),
  }
}

/** Newest first; once `limit` is reached the oldest entry is dropped (FIFO). */
export const appendRequest = (
  recent: readonly RequestLogEntry[],
  entry: RequestLogEntry,
  limit: number = DEFAULT_RECENT_LIMIT,
): RequestLogEntry[] => [entry, ...recent].slice(0, Math.max(0, limit))
