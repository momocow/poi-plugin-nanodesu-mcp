/**
 * What the *positional* rows at known store paths mean.
 *
 * Most of what this server returns is self-describing: kcsapi records are
 * objects, so `poi_describe` can answer "what fields are here" by reading their
 * keys. A few of the most-read paths are not. `info.resources` is eight bare
 * numbers; every akashic-records log row is a bare array. For those, the field
 * names exist only in the producing code, and `poi_describe` reports
 * `["0", "1", ...]` — the shape, with the part that carries the meaning missing.
 *
 * That gap is not cosmetic. A caller that guesses the order gets plausible
 * numbers with the wrong labels attached, which is worse than an error: reading
 * `info.resources[4]` as buckets when it is instant-construction turns the
 * scarcest resource into the most plentiful one, and nothing about the response
 * looks wrong.
 *
 * This is not the name resolution the design doc rules out ("no joining
 * api_ship_id to api_name, no derived fields"). Nothing here reads master data
 * or computes a value; the returned data is unchanged. These are field *names*
 * for a shape that has none inline — the same question `sampleFields` already
 * answers for every object-shaped path.
 *
 * ## Every entry cites its source
 *
 * These names are claims about someone else's data layout, and they go stale
 * when that layout changes. Two things keep a stale claim from becoming a
 * confident lie:
 *
 * 1. Each table below names the file it was read from. Re-read that file before
 *    editing an entry; do not infer an order from sampled values.
 * 2. `fieldsAt` checks the shape it was given against the entry's arity and
 *    withholds the names when they disagree (see `describeFields`). A caller
 *    then sees that the server's knowledge is stale, instead of names silently
 *    mapped onto the wrong columns.
 */

/**
 * Whether the value at a path is one positional row, or a collection of them.
 *
 * `info.resources` is the row itself; an akashic `.data` branch is an array of
 * rows. The distinction decides what gets arity-checked, and it is spelled out
 * rather than sniffed — "an array whose first element is an array" would also
 * describe plenty of ordinary kcsapi data.
 */
import { BATTLE_DETAIL_PACKAGE } from './battles.ts'
import { getByPath, parseFieldPath } from './paths.ts'

export type RowShape = 'row' | 'rows'

export type FieldEntry = {
  shape: RowShape
  /** One name per element, in order. */
  fields: string[]
}

/**
 * Field names for `info.resources`.
 *
 * Source: poi's own `views/redux/info/resources.ts`, whose FORMAT comment is
 * the authority for this order:
 *
 *     0: <Fuel>                 4: <Instant construction>
 *     1: <Ammo>                 5: <Fast repair (bucket)>
 *     2: <Steel>                6: <Development material>
 *     3: <Bauxite>              7: <Improvement material>
 *
 * Note which way round 4 and 5 are — that pair is the one that gets guessed
 * wrong, in both directions, because two other id spaces order them the other
 * way (see `PATH_NOTES`).
 */
const RESOURCE_FIELDS = [
  'fuel',
  'ammo',
  'steel',
  'bauxite',
  'instantBuild',
  'instantRepair',
  'devMaterial',
  'improveMaterial',
]

/**
 * The poi package whose log rows are named below.
 *
 * Only the `-ex` fork is described here. The upstream
 * `poi-plugin-akashic-records` is allowlisted for reading too, but its column
 * table has not been read, and the forked one is not evidence for it — an
 * unverified guess is exactly what this module exists to prevent. Reading
 * upstream's `tab.ts` is all it would take to add.
 */
export const AKASHIC_EX_PACKAGE = 'poi-plugin-akashic-records-ex'

/**
 * Column names for the akashic-records-ex logs.
 *
 * Source: that plugin's `views/reducers/tab.ts` (`tableTab`), with two
 * adjustments, both visible in its `views/components/table-area.tsx`:
 *
 * - **The leading `No.` column is dropped.** It is the rendered row number, not
 *   stored data: the table renders `data[i]` against title `[i + 1]`. So a
 *   12-name list here matches the 13-title table there.
 * - **Display titles are normalized to identifiers.** `tab.ts` holds strings
 *   meant for a table header, including "Flagship (Second Fleet)" and a
 *   `mission` row with two different columns both titled "Number". Names that
 *   collide cannot describe distinct positions, so they are disambiguated
 *   (`item1Count`, `item2Count`) and the resource columns are spelled to match
 *   `RESOURCE_FIELDS` rather than the header's "Fast Build Item".
 */
const AKASHIC_EX_FIELDS: Record<string, string[]> = {
  attack: [
    'time',
    'world',
    'node',
    'sortieType',
    'battleResult',
    'enemyEncounters',
    'drop',
    'heavilyDamaged',
    'flagship',
    'flagshipEscort',
    'mvp',
    'mvpEscort',
  ],
  mission: [
    'time',
    'type',
    'result',
    'fuel',
    'ammo',
    'steel',
    'bauxite',
    'item1',
    'item1Count',
    'item2',
    'item2Count',
  ],
  createitem: [
    'time',
    'result',
    'developmentItem',
    'type',
    'fuel',
    'ammo',
    'steel',
    'bauxite',
    'flagship',
    'hqLevel',
  ],
  createship: [
    'time',
    'type',
    'ship',
    'shipType',
    'fuel',
    'ammo',
    'steel',
    'bauxite',
    'devMaterial',
    'emptyDocks',
    'flagship',
    'hqLevel',
  ],
  retirement: ['time', 'type', 'shipType', 'ship'],
  quest: ['time', 'event', 'category', 'questId', 'quest', 'rewards'],
  resource: [
    'time',
    'fuel',
    'ammo',
    'steel',
    'bauxite',
    'instantBuild',
    'instantRepair',
    'devMaterial',
    'improveMaterial',
  ],
}

const akashicEntries = (): Record<string, FieldEntry> => {
  const out: Record<string, FieldEntry> = {}
  for (const [type, fields] of Object.entries(AKASHIC_EX_FIELDS)) {
    out[`ext.${AKASHIC_EX_PACKAGE}._.${type}.data`] = { shape: 'rows', fields }
  }
  return out
}

/** Positional layouts, by the store path they describe. */
export const FIELD_TABLE: Record<string, FieldEntry> = {
  'info.resources': { shape: 'row', fields: RESOURCE_FIELDS },
  ...akashicEntries(),
}

/**
 * Warnings that a path's own data cannot carry, by the path they apply to.
 *
 * Both of these are name collisions between id spaces: a value that is readable
 * and plausible under the wrong reading, so neither the data nor a schema can
 * flag it. They belong here for the same reason the field names do — the caller
 * learns it from this server or learns it from a wrong answer.
 */
/**
 * The game's clock, which is not the reader's.
 *
 * kcsapi's `api_*_time_str` fields are formatted by the game server in JST and
 * carry no offset, so they read as perfectly ordinary local times and are wrong
 * by the reader's offset.
 *
 * Observed on a live *repair* dock: `api_complete_time_str` of
 * "2026-09-15 17:44:39" for an `api_complete_time` that is 16:44:39 in UTC+8 and
 * 17:44:39 in Asia/Tokyo. The construction docks were empty at the time, so the
 * same claim there rests on it being the same field, from the same server, in
 * the same response — strong, but one step short of observed, and the note says
 * so rather than borrowing the repair dock's evidence.
 *
 * The epoch field beside it is the unambiguous one, which is why this points at
 * it rather than merely warning.
 */
const GAME_CLOCK_NOTE =
  'the api_*_time_str strings here are on the *game* clock, JST (UTC+9), and carry no timezone ' +
  'marker — so they look like local times and are off by your offset. Observed on a repair ' +
  'dock: "2026-09-15 17:44:39" for an instant that is 16:44:39 in UTC+8. Use the ' +
  'api_*_time epoch beside it. The game\'s own daily boundaries, such as the 05:00 quest ' +
  'reset, are on this clock too.'

/** The poi package whose senka histories the notes below describe. */
export const SENKA_PACKAGE = 'poi-plugin-senka-calc'

export const senkaPath = (branch: string): string => `ext.${SENKA_PACKAGE}._.${branch}`

/**
 * Why every senka history needs a note: its keys are not instants.
 *
 * Each of these branches is a `Record<number, …>` whose keys came from
 * `getDateNo()`/`getRankDateNo()` (that plugin's `lib/util.js`) — the count of
 * whole 12-hour periods since the start of the current JST month. They are
 * small integers that reset monthly, and a caller who reads one as an epoch
 * gets 1970 for every record; one who reads it as a day-of-month is off by a
 * factor of two. Nothing in the data says which, so this has to.
 *
 * The anchor differs by two reducers, and by an hour: experience and quest
 * records are cut at 02:00 JST on the 1st, ranking records at 03:00 — which is
 * why the same period number does not name quite the same window across these
 * branches.
 *
 * The sparseness warning is not hypothetical. In a live archive on the 21st
 * (period 41), `experienceHistory` was missing periods 17, 18, 36 and 37, and
 * the `rank*` branches held 11 of the 41 — a period exists only if poi saw the
 * response that fills it, and for the rankings that means the player opened the
 * in-game ranking page during it.
 */
const senkaPeriods = (anchor: string) =>
  `keys here are 12-hour *period* numbers inside the current JST month, not timestamps and not ` +
  `days: floor((then - ${anchor} JST on the 1st) / 12h), counting 0, 1, 2, … and starting over ` +
  `each month. Period 0 is the month's first half-day; even keys are the 02:00-14:00 half, odd ` +
  `keys the 14:00-02:00 one. Read as an epoch, every record dates to 1970. Keys are sparse: a ` +
  `period is recorded only if poi saw the response that fills it, so a gap means no observation, ` +
  `never a zero — do not read consecutive keys as consecutive periods.`

/** Period keys anchored at 02:00 JST (`getDateNo`). */
const SENKA_DATE_PERIODS = senkaPeriods('02:00')

/** Period keys anchored at 03:00 JST (`getRankDateNo`), one hour later. */
const SENKA_RANK_PERIODS = senkaPeriods('03:00')

/**
 * Notes for the senka histories, by store path.
 *
 * Source: `poi-plugin-senka-calc` v5.5.1 — `reducers/*.js` for what each branch
 * holds, `lib/util.js` for the key numbering, `lib/const.js` for the rate and
 * the EO table.
 */
const SENKA_NOTES: Record<string, string> = {
  [senkaPath('experienceHistory')]:
    `${SENKA_DATE_PERIODS} One key is not a period at all: **1000 holds the current HQ ` +
    `experience**, rewritten on every port/battle/mission response. A period key holds the ` +
    `experience carried *into* that period, so the month's ordinary senka is ` +
    `(value at 1000 - value at the lowest period key present) * 7/10000.`,
  [senkaPath('rank5')]: SENKA_RANK_PERIODS,
  [senkaPath('rank20')]: SENKA_RANK_PERIODS,
  [senkaPath('rank100')]: SENKA_RANK_PERIODS,
  [senkaPath('rank501')]: SENKA_RANK_PERIODS,
  [senkaPath('rankUser')]: SENKA_RANK_PERIODS,
  [senkaPath('exHistory')]:
    `${SENKA_DATE_PERIODS} Values are arrays of EO map ids in the game's two-digit form (55 is ` +
    `map 5-5), recorded in the period the map was first seen cleared. Only the eight maps in ` +
    `the plugin's own EX_MAPS table are tracked, and in v5.5.1 that table omits 56 (5-6), so ` +
    `clearing 5-6 never appears here — the game-side senka in the rank branches is unaffected.`,
  [senkaPath('questHistory')]:
    `${SENKA_DATE_PERIODS} Values are arrays of senka-quest ids cleared in that period, and ` +
    `**1000 is again not a period**: it holds quests cleared after this month's quest deadline, ` +
    `whose senka counts toward next month.`,
}

export const PATH_NOTES: Record<string, string> = {
  ...SENKA_NOTES,
  'info.resources':
    'these positions are their own id space: index = kcsapi material id - 1, and unrelated to ' +
    "poi_lookup(kind='useitems') ids, which order instant-repair and instant-build the other " +
    'way round. Do not map one onto another; use the names above.',
  'info.repairs':
    "api_ship_id here is the *roster* id (a key into info.ships), not a master ship id as the " +
    'same field name means elsewhere. poi_lookup(kind="ships") on it resolves to an unrelated ' +
    'ship rather than failing; read info.ships[<that value>].api_ship_id first. Also: ' +
    GAME_CLOCK_NOTE,
  'info.constructions': GAME_CLOCK_NOTE,
  [`ext.${BATTLE_DETAIL_PACKAGE}._.indexes`]:
    'two time fields, two meanings, neither labelled: time_ is the epoch in milliseconds, while ' +
    'time is a display string this plugin formatted in the *host* timezone — a third clock ' +
    'again, being neither the game\'s JST nor the UTC that timeRange reports. Sort and compare ' +
    'on time_.',
}

/** Prefix of the paths whose annotation depends on which akashic fork is installed. */
export const akashicExPrefix = `ext.${AKASHIC_EX_PACKAGE}.`

/**
 * Where a row's timestamp lives, by the path whose rows carry one.
 *
 * Spelled as a fieldpath so one map covers both row shapes: `[0]` for the
 * positional logs, a name for the object-shaped ones.
 *
 * Derived from `AKASHIC_EX_FIELDS` rather than written out, so a column
 * inserted in front of `time` cannot leave this pointing at the old position.
 * battle-detail's index is added by hand because its rows are objects: `time_`
 * is the epoch-millisecond field, as against its `time`, a display string that
 * sorts and compares wrong.
 */
export const TIME_FIELDS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(AKASHIC_EX_FIELDS)
      .map(([type, fields]) => [`ext.${AKASHIC_EX_PACKAGE}._.${type}.data`, fields.indexOf('time')])
      .filter(([, at]) => (at as number) >= 0)
      .map(([path, at]) => [path, `[${at as number}]`]),
  ),
  [`ext.${BATTLE_DETAIL_PACKAGE}._.indexes`]: 'time_',
}

/**
 * The window a value must fall in to be read as an epoch-millisecond instant.
 *
 * Interpreting a number as a date is another claim about someone else's data,
 * and a producer that switched to seconds would otherwise have every row
 * reported as 1970 — a confident answer, uniformly wrong. Outside this window
 * the range is withheld instead. The lower bound predates the game itself, so
 * no real record can fall below it.
 */
const EPOCH_MS_FLOOR = Date.UTC(2013, 0, 1)
const EPOCH_MS_CEILING = Date.UTC(2100, 0, 1)

export type TimeRange = {
  /** The fieldpath the instants were read from. */
  field: string
  /** Oldest and newest, as stored — what a `where` expression compares against. */
  min: number
  max: number
  /**
   * The same two instants, readable, in **UTC** (ISO 8601, with its `Z`).
   *
   * Deliberately a third clock from the two the data carries — the game's JST
   * strings and a plugin's host-local ones — and the only one of the three that
   * says so. Anything being compared or filtered should use `min`/`max`.
   */
  from: string
  to: string
  /** How many rows carried a usable instant. */
  counted: number
}

const rowsOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value
  }
  return value !== null && typeof value === 'object' ? Object.values(value) : []
}

/**
 * The span of time a collection actually covers.
 *
 * This answers the question that repeated probing cannot: where the data ends.
 * "No sortie that day" and "this log does not reach that far back" are the same
 * empty result to a `where` filter, and only one of them means what it looks
 * like — so a caller that cannot see the horizon will eventually report an
 * absence that is really a blind spot.
 *
 * Every row is scanned rather than reading the ends. The logs are a few
 * thousand rows, so the scan is free, and it holds whatever order the producer
 * writes in — the one akashic table measured here is newest-first, but that is
 * an observation about that table, not a promise from the plugin, and a wrong
 * assumption would silently swap `from` and `to`.
 */
export function timeRangeAt(path: string, value: unknown): TimeRange | undefined {
  const field = TIME_FIELDS[path]
  if (field === undefined) {
    return undefined
  }

  const segments = parseFieldPath(field)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let counted = 0

  for (const row of rowsOf(value)) {
    const at = getByPath(row, segments)
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      continue
    }
    if (at < EPOCH_MS_FLOOR || at >= EPOCH_MS_CEILING) {
      return undefined
    }
    min = Math.min(min, at)
    max = Math.max(max, at)
    counted++
  }

  return counted === 0
    ? undefined
    : {
        field,
        min,
        max,
        from: new Date(min).toISOString(),
        to: new Date(max).toISOString(),
        counted,
      }
}

const listFields = (fields: string[]): string =>
  fields.map((name, i) => `[${i}] ${name}`).join(', ')

export type FieldDescription = {
  /** Verified names for the positional elements, or undefined when withheld. */
  fields?: string[]
  /** Prose for the caller: the field listing, any path warning, any staleness. */
  note?: string
}

/**
 * What `value` says about whether this entry's names still fit.
 *
 * Three answers, and the distinction between the first two is the whole point:
 * an empty log is silent on the question, while a value that is not a
 * positional array *at all* is the loudest possible evidence that the layout
 * moved. Collapsing those two into "no evidence" would publish the names in the
 * one case where they are certainly wrong.
 */
type RowCheck =
  | { verdict: 'unknown' }
  | { verdict: 'arity'; arity: number }
  | { verdict: 'not-positional'; found: string }

const kindOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`

const checkRow = (shape: RowShape, value: unknown): RowCheck => {
  if (!Array.isArray(value)) {
    return { verdict: 'not-positional', found: kindOf(value) }
  }
  if (shape === 'row') {
    return { verdict: 'arity', arity: value.length }
  }
  if (value.length === 0) {
    return { verdict: 'unknown' }
  }
  const first = value[0]
  return Array.isArray(first)
    ? { verdict: 'arity', arity: first.length }
    : { verdict: 'not-positional', found: `rows that are ${kindOf(first)}` }
}

/**
 * Describe the positional layout at `path`, given the value found there.
 *
 * The value is passed in because the names are only as good as the shape they
 * were written for. When the arity disagrees with this module's table, the
 * names are withheld and the disagreement is reported instead: a caller told
 * "the layout changed" can go and look, while a caller handed twelve names for
 * a thirteen-column row has been actively misled. An unannotated path, or one
 * whose value is not an array at all, produces nothing.
 */
export function describeFields(path: string, value: unknown): FieldDescription {
  const entry = FIELD_TABLE[path]
  const pathNote = PATH_NOTES[path]

  if (entry === undefined) {
    return pathNote === undefined ? {} : { note: pathNote }
  }

  const check = checkRow(entry.shape, value)
  const stale =
    check.verdict === 'not-positional'
      ? `field names withheld: ${path} is ${check.found} where this server expected a ` +
        `positional array, so the layout it was told about has changed`
      : check.verdict === 'arity' && check.arity !== entry.fields.length
        ? `field names withheld: ${path} now has ${check.arity} positions where this server ` +
          `has names for ${entry.fields.length}, so the layout it was told about has changed`
        : undefined

  if (stale !== undefined) {
    return { note: pathNote === undefined ? stale : `${stale}. ${pathNote}` }
  }

  const listing =
    entry.shape === 'row'
      ? `positional array — ${listFields(entry.fields)}`
      : `each row is a positional array — ${listFields(entry.fields)}`

  return {
    fields: entry.fields,
    note: pathNote === undefined ? listing : `${listing}. ${pathNote}`,
  }
}
