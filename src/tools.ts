import { BATTLE_DETAIL_PACKAGE, type ReadBattle } from './battles.ts'
import { describeFields, timeRangeAt, type TimeRange } from './fields.ts'
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

export type BattleArgs = { ids: number[]; select?: string[]; maxBytes?: number }

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
  /**
   * What the path's own data cannot say: the meaning of positional columns, or
   * a field name that means something else here than it does elsewhere.
   */
  note?: string
  /**
   * The span of time this collection covers, when its rows carry an instant.
   *
   * Reported so a caller can tell an absence from a blind spot without probing
   * for the edge: a filter that matches nothing means one thing inside this
   * range and quite another outside it.
   */
  timeRange?: TimeRange
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }

export const DEFAULT_LIMIT = 200
export const DEFAULT_MAX_BYTES = 65536
export const MAX_MAX_BYTES = 262144
export const MAX_LOOKUP_IDS = 200
export const MAX_DESCRIBE_KEYS = 50

/**
 * Far below `MAX_LOOKUP_IDS`, because these records are not small: a battle is
 * ~22 KB whole, against a few hundred bytes for a master-data row.
 */
export const MAX_BATTLE_IDS = 50

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

/**
 * What fills a branch decides why it is empty. The quest list is filled by
 * opening the quest panel in game — poi only ever sees the quests the game was
 * asked to send — so the default hint would send a caller to wait for a load
 * that has already happened.
 */
const EMPTY_HINTS: Record<string, string> = {
  'ext.poi-plugin-quest-line._.questList':
    'branch is empty — open the quest panel in game at least once; the game only sends the ' +
    'quest list when asked, so poi has not seen one yet',
}

const emptyHintFor = (path: string): string => EMPTY_HINTS[path] ?? EMPTY_HINT

const badMaxBytes = (maxBytes: number): string | undefined => {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return 'maxBytes must be a positive number'
  }
  if (maxBytes > MAX_MAX_BYTES) {
    return `maxBytes ${maxBytes} exceeds the hard maximum of ${MAX_MAX_BYTES}`
  }
  return undefined
}

export function poiGet(store: unknown, args: GetArgs): ToolResult<GetData> {
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES
  const rejected = badMaxBytes(maxBytes)
  if (rejected !== undefined) {
    return { ok: false, error: rejected }
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
  const hints: string[] = []

  // Described from the value as stored, not as returned: where/select/limit
  // change the shape of this response, never the layout being described. Sent
  // on every read of an annotated path, because the caller who most needs the
  // column names is the one who did not think to call poi_describe first.
  const described = describeFields(args.path, resolved.value)
  if (described.note !== undefined) {
    hints.push(described.note)
  }

  if (payload.kind === 'object-map' || payload.kind === 'array') {
    if (payload.total === 0) {
      hints.push(emptyHintFor(args.path))
    } else if (payload.truncated) {
      hints.push(
        `showing ${payload.returned} of ${payload.total} — narrow with where/select, ` +
          `or raise limit/maxBytes`,
      )
    }
  }

  return { ok: true, data: hints.length > 0 ? { ...payload, hint: hints.join('; ') } : payload }
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

/**
 * Read whole battle records by id, as saved by poi-plugin-battle-detail.
 *
 * Ids come from that plugin's index (`ext.poi-plugin-battle-detail._.indexes`),
 * which is what says a battle happened and when. This returns what the index
 * cannot: the fleet that sortied, with each ship's level and equipment.
 *
 * An id with no readable file is omitted rather than failing the call — one
 * deleted or half-written record should not lose the rest of a batch — and the
 * hint names what went missing.
 */
export function poiBattle(read: ReadBattle | undefined, args: BattleArgs): ToolResult<GetData> {
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES
  const rejected = badMaxBytes(maxBytes)
  if (rejected !== undefined) {
    return { ok: false, error: rejected }
  }

  if (read === undefined) {
    return {
      ok: false,
      error:
        'battle records are not available: poi did not provide a data directory, so there is ' +
        `nowhere to read ${BATTLE_DETAIL_PACKAGE}'s records from`,
    }
  }

  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    return {
      ok: false,
      error:
        'ids must be a non-empty array of battle ids, as found in ' +
        `ext.${BATTLE_DETAIL_PACKAGE}._.indexes`,
    }
  }
  if (args.ids.length > MAX_BATTLE_IDS) {
    return {
      ok: false,
      error:
        `too many ids (${args.ids.length}); the maximum is ${MAX_BATTLE_IDS} per call. ` +
        'A whole battle is ~22 KB, so narrow with select before widening the batch.',
    }
  }

  const items: Record<string, unknown> = {}
  const missing: number[] = []
  for (const id of args.ids) {
    let record: unknown
    try {
      record = read(id)
    } catch {
      missing.push(id)
      continue
    }
    items[String(id)] = args.select ? applySelect(record, args.select) : toJsonSafe(record)
  }

  const fitted = fitToBytes(
    {
      kind: 'object-map',
      total: args.ids.length,
      returned: Object.keys(items).length,
      truncated: false,
      items,
    },
    maxBytes,
  )
  if (!fitted.ok) {
    return { ok: false, error: fitted.error }
  }

  const payload = fitted.payload
  const hints: string[] = []
  if (payload.kind === 'object-map' && payload.truncated) {
    hints.push(
      `showing ${payload.returned} of ${payload.total} — narrow with select, or raise maxBytes`,
    )
  }
  if (missing.length > 0) {
    hints.push(`no readable record for ${missing.join(', ')}`)
  }

  return {
    ok: true,
    data: hints.length > 0 ? { ...payload, hint: hints.join('; ') } : payload,
  }
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

  // Known names win over read-off-the-sample ones. For a positional row the
  // latter are the indices themselves — the shape restated, with the meaning
  // still missing, which is what sends a caller off to guess.
  const described = describeFields(path, value)

  if (Array.isArray(value)) {
    return {
      ok: true,
      data: {
        path,
        kind: 'array',
        total: value.length,
        sampleFields: described.fields ?? fieldsOf(value[0]),
        note: described.note,
        timeRange: timeRangeAt(path, value),
      },
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
          described.fields ??
          (firstKey === undefined
            ? undefined
            : fieldsOf((value as Record<string, unknown>)[firstKey])),
        note: described.note,
        timeRange: timeRangeAt(path, value),
      },
    }
  }

  return {
    ok: true,
    data: { path, kind: 'object', keys: keys.slice(0, MAX_DESCRIBE_KEYS), note: described.note },
  }
}
