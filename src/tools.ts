import { readableRoots, resolveStorePath } from './paths.ts'
import { applyQuery, applySelect, isCollection, type QueryResult } from './query.ts'
import { fitToBytes, toJsonSafe } from './serialize.ts'

export type GetArgs = {
  path: string
  where?: string
  select?: string[]
  limit?: number
  maxBytes?: number
  treatAs?: 'collection' | 'value'
}

export type LookupArgs = { kind: string; ids: number[]; select?: string[] }

export type DescribeArgs = { path?: string }

export type GetData = QueryResult & { hint?: string }

export type DescribeData = {
  path: string
  kind: 'object-map' | 'array' | 'object' | 'scalar'
  type?: string
  total?: number
  keys?: string[]
  sampleKeys?: string[]
  sampleFields?: string[]
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }

export const DEFAULT_LIMIT = 200
export const DEFAULT_MAX_BYTES = 65536
export const MAX_MAX_BYTES = 262144
export const MAX_LOOKUP_IDS = 200
export const MAX_DESCRIBE_KEYS = 50

/**
 * Master-data tables, by the short name callers use.
 *
 * `poi_lookup` requires explicit ids so these tables are never dumped whole by
 * accident — `const.$ships` alone is ~1.6 MB.
 */
export const LOOKUP_KINDS: Record<string, string> = {
  ships: 'const.$ships',
  equips: 'const.$equips',
  shipTypes: 'const.$shipTypes',
  equipTypes: 'const.$equipTypes',
  maps: 'const.$maps',
  mapareas: 'const.$mapareas',
  missions: 'const.$missions',
  useitems: 'const.$useitems',
  shipUpgrades: 'const.$shipUpgrades',
  shipgraph: 'const.$shipgraph',
  graphs: 'const.$graphs',
  exslotEquips: 'const.$exslotEquips',
  exslotEquipShips: 'const.$exslotEquipShips',
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

const EMPTY_HINT = 'branch is empty — poi may not have loaded the game yet'

export function poiGet(store: unknown, args: GetArgs): ToolResult<GetData> {
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { ok: false, error: 'maxBytes must be a positive number' }
  }
  if (maxBytes > MAX_MAX_BYTES) {
    return { ok: false, error: `maxBytes ${maxBytes} exceeds the hard maximum of ${MAX_MAX_BYTES}` }
  }

  const resolved = resolveStorePath(store, args.path)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error }
  }

  let queried: QueryResult
  try {
    queried = applyQuery(resolved.value, {
      where: args.where,
      select: args.select,
      limit: args.limit ?? DEFAULT_LIMIT,
      treatAs: args.treatAs,
    })
  } catch (e) {
    return { ok: false, error: messageOf(e) }
  }

  const fitted = fitToBytes(queried, maxBytes)
  if (!fitted.ok) {
    return { ok: false, error: fitted.error }
  }

  const payload = fitted.payload
  if (payload.kind === 'object-map' || payload.kind === 'array') {
    if (payload.total === 0) {
      return { ok: true, data: { ...payload, hint: EMPTY_HINT } }
    }
    if (payload.truncated) {
      const hint =
        `showing ${payload.returned} of ${payload.total} — narrow with where/select, ` +
        `or raise limit/maxBytes`
      return { ok: true, data: { ...payload, hint } }
    }
  }

  return { ok: true, data: payload }
}

export function poiLookup(store: unknown, args: LookupArgs): ToolResult<unknown> {
  const path = LOOKUP_KINDS[args.kind]
  if (path === undefined) {
    const valid = Object.keys(LOOKUP_KINDS).join(', ')
    return { ok: false, error: `unknown kind '${args.kind}'. Valid kinds: ${valid}` }
  }

  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    return { ok: false, error: 'ids must be a non-empty array of numbers' }
  }
  if (args.ids.length > MAX_LOOKUP_IDS) {
    return {
      ok: false,
      error: `too many ids (${args.ids.length}); the maximum is ${MAX_LOOKUP_IDS} per call`,
    }
  }

  const resolved = resolveStorePath(store, path)
  if (!resolved.ok) {
    return { ok: false, error: `master table '${path}' is not available: ${resolved.error}` }
  }

  const table = resolved.value
  if (table === null || typeof table !== 'object') {
    return { ok: false, error: `master table '${path}' is not available` }
  }

  const rows = table as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const id of args.ids) {
    const record = rows[String(id)]
    if (record === undefined) {
      continue
    }
    out[String(id)] = args.select ? applySelect(record, args.select) : toJsonSafe(record)
  }

  return { ok: true, data: out }
}

export function poiDescribe(store: unknown, args: DescribeArgs): ToolResult<DescribeData> {
  if (args.path === undefined || args.path === '') {
    return { ok: true, data: { path: '(root)', kind: 'object', keys: readableRoots(store) } }
  }

  const resolved = resolveStorePath(store, args.path)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error }
  }

  const value = resolved.value
  const path = args.path

  if (value === null || typeof value !== 'object') {
    return { ok: true, data: { path, kind: 'scalar', type: value === null ? 'null' : typeof value } }
  }

  const fieldsOf = (sample: unknown): string[] | undefined =>
    sample !== null && typeof sample === 'object'
      ? Object.keys(sample).slice(0, MAX_DESCRIBE_KEYS)
      : undefined

  if (Array.isArray(value)) {
    return {
      ok: true,
      data: { path, kind: 'array', total: value.length, sampleFields: fieldsOf(value[0]) },
    }
  }

  const keys = Object.keys(value)

  if (isCollection(value)) {
    const firstKey = keys[0]
    return {
      ok: true,
      data: {
        path,
        kind: 'object-map',
        total: keys.length,
        sampleKeys: keys.slice(0, MAX_DESCRIBE_KEYS),
        sampleFields:
          firstKey === undefined
            ? undefined
            : fieldsOf((value as Record<string, unknown>)[firstKey]),
      },
    }
  }

  return { ok: true, data: { path, kind: 'object', keys: keys.slice(0, MAX_DESCRIBE_KEYS) } }
}
