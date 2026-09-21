import { BATTLE_DETAIL_PACKAGE, type ReadBattle } from './battles.ts'
import { describeFields, timeRangeAt, type TimeRange } from './fields.ts'
import {
  buildSaveAction,
  HENSEI_DATA_PATH,
  HENSEI_PACKAGE,
  readHenseiTitles,
  type HenseiCalc,
  type HenseiFleet,
} from './hensei.ts'
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

export type HenseiSaveArgs = {
  title: string
  note?: string
  decks?: number[]
  code?: unknown
  overwrite?: boolean
}

/**
 * What the save needs from outside. `dispatch` and `calc` are optional because
 * both can be genuinely absent — outside poi, or with hensei-nikki not
 * installed — and the tool reports that rather than pretending to work.
 */
export type HenseiSaveDeps = {
  store: unknown
  dispatch?: (action: unknown) => void
  calc?: HenseiCalc
}

export type HenseiSaveData = {
  title: string
  /** Fleets saved, and ships across them: enough to see the record is not empty. */
  fleets: number
  ships: number
  /** True when an existing record of this title was replaced. */
  overwritten: boolean
}

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

/** Fleets the game itself has: deck numbers are 1-based, as poi shows them. */
export const MAX_DECKS = 4

const countShips = (fleets: HenseiFleet[]): number =>
  fleets.reduce<number>((total, fleet) => total + fleet.filter((ship) => ship != null).length, 0)

/**
 * Convert live fleets into hensei-nikki's record format, the way their own Add
 * flow does: the deck's `api_ship` instance ids, resolved against `info.ships`
 * and `info.equips` by their converter. Empty slots (`-1`) are dropped there.
 */
function fleetsFromDecks(
  store: unknown,
  calc: HenseiCalc,
  decks: number[],
): ToolResult<HenseiFleet[]> {
  if (!Array.isArray(decks) || decks.length === 0) {
    return { ok: false, error: `decks must be a non-empty array of deck numbers (1-${MAX_DECKS})` }
  }
  const bad = decks.filter((deck) => !Number.isInteger(deck) || deck < 1 || deck > MAX_DECKS)
  if (bad.length > 0) {
    return {
      ok: false,
      error: `deck numbers must be integers from 1 to ${MAX_DECKS}; got ${bad.join(', ')}`,
    }
  }
  if (new Set(decks).size !== decks.length) {
    // Saving the same fleet twice into one record is never what was meant.
    return { ok: false, error: `decks contains the same deck more than once: ${decks.join(', ')}` }
  }

  const sources: unknown[] = []
  for (const path of ['info.fleets', 'info.ships', 'info.equips']) {
    const resolved = resolveStorePath(store, path)
    if (!resolved.ok) {
      return { ok: false, error: resolved.error }
    }
    sources.push(resolved.value)
  }
  const [allFleets, ships, equips] = sources

  if (!Array.isArray(allFleets)) {
    return { ok: false, error: 'info.fleets is not available — poi may not have loaded the game yet' }
  }
  const absent = decks.filter((deck) => deck > allFleets.length)
  if (absent.length > 0) {
    return {
      ok: false,
      error:
        `no deck ${absent.join(', ')}: this account has ${allFleets.length} ` +
        `fleet${allFleets.length === 1 ? '' : 's'}`,
    }
  }

  const ids: unknown[] = []
  for (const deck of decks) {
    const fleet = allFleets[deck - 1] as { api_ship?: unknown } | undefined
    const members = fleet?.api_ship
    if (!Array.isArray(members)) {
      return { ok: false, error: `deck ${deck} has no api_ship list to read` }
    }
    ids.push(members.map((id) => ({ id })))
  }

  try {
    return { ok: true, data: calc.getHenseiDataByApi(ids, ships, equips) }
  } catch (e) {
    return { ok: false, error: `could not read the fleets: ${messageOf(e)}` }
  }
}

/**
 * Save a fleet composition into poi-plugin-hensei-nikki (編成日記).
 *
 * The only tool here that changes anything. It dispatches that plugin's own
 * save action into poi's shared store — the same action its Add button
 * dispatches — and that plugin's observer persists the result to its file. See
 * src/hensei.ts for why it is done that way rather than by writing the file.
 *
 * Every refusal below exists because the alternative is a silent wrong answer:
 * a dispatch with no reducer mounted looks like success, and an existing title
 * is replaced outright by their reducer with no way back.
 */
export function poiHenseiSave(
  deps: HenseiSaveDeps,
  args: HenseiSaveArgs,
): ToolResult<HenseiSaveData> {
  const { store, dispatch, calc } = deps

  if (calc === undefined) {
    return {
      ok: false,
      error:
        `saving is not available: the '${HENSEI_PACKAGE}' poi plugin is not installed, so ` +
        'there is nothing to save a record into. Install or enable it in poi.',
    }
  }
  if (dispatch === undefined) {
    return {
      ok: false,
      error: 'saving is not available: poi did not provide a dispatch, so nothing can be written',
    }
  }

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title === '') {
    return { ok: false, error: 'title is required and cannot be blank' }
  }

  // Also the liveness check: their slice is absent exactly when their reducer
  // is not mounted, and then a dispatch would change nothing.
  const existing = readHenseiTitles(store)
  if (!existing.ok) {
    return { ok: false, error: existing.error }
  }

  const overwritten = existing.titles.includes(title)
  if (overwritten && args.overwrite !== true) {
    return {
      ok: false,
      error:
        `a record titled '${title}' already exists. Saving would replace it outright and the ` +
        `old composition could not be recovered — read it at ${HENSEI_DATA_PATH} first, then ` +
        'pass overwrite: true to replace it, or choose another title.',
    }
  }

  const hasDecks = args.decks !== undefined
  const hasCode = args.code !== undefined
  if (hasDecks === hasCode) {
    return {
      ok: false,
      error: hasDecks
        ? 'pass either decks or code, not both'
        : `pass decks (e.g. [1] for the first fleet) or code (a composition to import)`,
    }
  }

  let built: ToolResult<HenseiFleet[]>
  if (hasDecks) {
    built = fleetsFromDecks(store, calc, args.decks as number[])
  } else {
    try {
      built = { ok: true, data: calc.getHenseiDataByCode(args.code) }
    } catch (e) {
      built = { ok: false, error: `could not read the composition: ${messageOf(e)}` }
    }
  }
  if (!built.ok) {
    return built
  }

  const fleets = built.data
  const ships = countShips(fleets)
  if (fleets.length === 0 || ships === 0) {
    // hensei-nikki skips empty data when persisting, so this would appear to
    // save and then not be there after a restart.
    return {
      ok: false,
      error: 'nothing to save: the selected fleets are empty, and an empty record is not kept',
    }
  }

  const note = typeof args.note === 'string' ? args.note.trim() : ''
  dispatch(buildSaveAction(title, fleets, note))

  return { ok: true, data: { title, fleets: fleets.length, ships, overwritten } }
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
