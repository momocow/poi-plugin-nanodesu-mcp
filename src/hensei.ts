/**
 * The one place that knows about poi-plugin-hensei-nikki (編成日記).
 *
 * This is the plugin's only *write* path, and it is a write into someone
 * else's state, so it is worth being precise about what makes that legitimate.
 * poi keeps a single redux store shared by every plugin and publishes
 * `window.dispatch` in the renderer; hensei-nikki adds a record with one plain
 * action, `{ type: '@@HENSEI_SAVE_DATA', title, fleets }` (its `redux/index.ts`).
 * Dispatching that is exactly what its own "Add" button does.
 *
 * Persistence is deliberately *not* ours. hensei-nikki's `pluginDidLoad`
 * installs a redux-observers observer that writes
 * `<APPDATA>/hensei-nikki/<memberId>.json` whenever its slice changes, so a
 * dispatch lands on disk without this plugin touching the file. Writing that
 * file directly would mean owning a second copy of their storage format and
 * racing their FileWriter for it.
 *
 * Two consequences follow, and both are enforced in src/tools.ts rather than
 * here: if the plugin is not installed there is no conversion to reuse, and if
 * it is installed but not *loaded* its reducer is not mounted — the dispatch
 * would be swallowed by poi and the caller would be told it succeeded.
 *
 * The record format (`poi-h-v1`) is theirs too, and converting live kcsapi
 * state into it is a hundred lines of KanColle-specific detail — expansion
 * slots, aircraft proficiency, three legacy encodings. That conversion is
 * loaded from their installed package rather than reimplemented, for the same
 * reason src/questline.ts reads their asset rather than restating it: a copy
 * would drift, and the drift would be silent.
 */

import { join } from 'node:path'

import { resolveStorePath } from './paths.ts'

/** The poi package whose records these are. */
export const HENSEI_PACKAGE = 'poi-plugin-hensei-nikki'

/**
 * Where its saved records live in the store. The `_` is poi's, not theirs:
 * every plugin reducer is wrapped in `combineReducers({ _: reducer })`.
 */
export const HENSEI_DATA_PATH = `ext.${HENSEI_PACKAGE}._.henseiData.data`

/** The action their reducer turns into `data[title] = fleets`. */
export const HENSEI_SAVE_ACTION = '@@HENSEI_SAVE_DATA'

/** The record format version their reducer and loader both require. */
export const HENSEI_RECORD_VERSION = 'poi-h-v1'

/** One saved fleet, as their `utils/calc.ts` defines it. Opaque here. */
export type HenseiFleet = unknown[]

/**
 * The two conversions their package exports, and the only ones used:
 * `ByApi` builds fleets from live kcsapi state (their Add flow), `ByCode`
 * from a pasted composition — deckbuilder v4, their own `poi-h-v1`, or one of
 * the legacy array encodings.
 */
export type HenseiCalc = {
  getHenseiDataByApi: (fleets: unknown, ships: unknown, equips: unknown) => HenseiFleet[]
  getHenseiDataByCode: (code: unknown) => HenseiFleet[]
}

export type HenseiSaveAction = {
  type: typeof HENSEI_SAVE_ACTION
  title: string
  fleets: { version: typeof HENSEI_RECORD_VERSION; fleets: HenseiFleet[]; note: string }
}

declare const require: ((id: string) => unknown) | undefined

/**
 * Their conversion module, relative to poi's data directory — the same path
 * poi itself resolves the package from.
 */
export const henseiCalcPath = (appDataPath: string): string =>
  join(appDataPath, 'plugins', 'node_modules', HENSEI_PACKAGE, 'utils', 'calc.js')

const isCalc = (value: unknown): value is HenseiCalc =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as HenseiCalc).getHenseiDataByApi === 'function' &&
  typeof (value as HenseiCalc).getHenseiDataByCode === 'function'

/**
 * Load their conversion, or `undefined` when it cannot be had.
 *
 * Every failure is the same non-event — not installed, moved in a later
 * version, a load error — and none is a reason to fail startup. The tool is
 * simply not registered, which is the honest answer to "can you save a record".
 *
 * `calc.js` is a leaf module with no dependencies of its own (verified against
 * hensei-nikki 5.0.5), so requiring it does not pull their redux or React in.
 */
export function loadHenseiCalc(
  appDataPath: string | undefined,
  requireModule: ((id: string) => unknown) | undefined = typeof require === 'function'
    ? require
    : undefined,
): HenseiCalc | undefined {
  if (appDataPath === undefined || appDataPath.length === 0 || requireModule === undefined) {
    return undefined
  }

  let loaded: unknown
  try {
    loaded = requireModule(henseiCalcPath(appDataPath))
  } catch {
    return undefined
  }

  return isCalc(loaded) ? loaded : undefined
}

/**
 * The titles already taken, or why they cannot be known.
 *
 * A failure here is never just a failed read: their slice is absent exactly
 * when their reducer is not mounted, and dispatching into a store with no
 * reducer for the action changes nothing while looking like success. So this
 * doubles as the liveness check that must pass before any dispatch.
 */
export function readHenseiTitles(store: unknown): { ok: true; titles: string[] } | { ok: false; error: string } {
  const resolved = resolveStorePath(store, HENSEI_DATA_PATH)
  if (!resolved.ok) {
    return {
      ok: false,
      error:
        `${HENSEI_PACKAGE} has no state in poi's store, so its reducer is not mounted and a ` +
        `record cannot be saved — a dispatch would be silently discarded. Enable the plugin ` +
        `in poi and let it load, then try again. (${resolved.error})`,
    }
  }

  const data = resolved.value
  if (data === null || typeof data !== 'object') {
    return { ok: false, error: `${HENSEI_DATA_PATH} is not a record map` }
  }

  return { ok: true, titles: Object.keys(data) }
}

/**
 * Build the action. `note` is always present because their edit UI reads it as
 * a string and an absent one would render as "undefined".
 */
export const buildSaveAction = (
  title: string,
  fleets: HenseiFleet[],
  note: string,
): HenseiSaveAction => ({
  type: HENSEI_SAVE_ACTION,
  title,
  fleets: { version: HENSEI_RECORD_VERSION, fleets, note },
})
