/**
 * Adapter over the poi globals this plugin depends on.
 *
 * These are read from `window` rather than imported from `views/env` and
 * `views/create-store`. Those modules export `isMain`, `config`, and `getStore`
 * only in poi's current development tree; in the released build (11.1.0) they
 * are side-effect modules that export nothing and install the same values on
 * `window` instead. Importing them there yields `undefined` silently — which is
 * exactly how this plugin came to sit at "stopped" with a clean console.
 *
 * The `window` globals are present in both, so this is the portable choice.
 */

export type GetStore = (path?: string) => unknown

type PoiWindow = {
  isMain?: unknown
  getStore?: unknown
  config?: { get?: unknown; set?: unknown }
  APPDATA_PATH?: unknown
}

const asPoiWindow = (value: unknown): PoiWindow =>
  value !== null && typeof value === 'object' ? (value as PoiWindow) : {}

export function isMainWindow(window: unknown): boolean {
  return asPoiWindow(window).isMain === true
}

export function resolveGetStore(window: unknown): GetStore {
  const getStore = asPoiWindow(window).getStore
  if (typeof getStore !== 'function') {
    throw new Error(
      'poi did not provide window.getStore — the plugin cannot read the store. ' +
        'This usually means it was loaded outside poi, or poi changed its API.',
    )
  }
  return getStore as GetStore
}

/**
 * poi's data directory (`~/Library/Application Support/poi` on macOS), where
 * installed plugins and their assets live.
 *
 * Absent outside poi, and absent in a poi old enough not to set it — both mean
 * the same thing to every caller: anything read from disk is unavailable.
 */
export function readAppDataPath(window: unknown): string | undefined {
  const value = asPoiWindow(window).APPDATA_PATH
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * An integer setting within a range, or the fallback. Anything poi cannot
 * supply — no config object, a throwing read, a value that is not an integer
 * in range — yields the fallback, because a broken config read is never a
 * reason not to start.
 */
export function readIntConfig(
  window: unknown,
  key: string,
  bounds: { fallback: number; min: number; max: number },
): number {
  const get = asPoiWindow(window).config?.get
  if (typeof get !== 'function') {
    return bounds.fallback
  }

  let value: unknown
  try {
    value = (get as (path: string, fallback: number) => unknown)(key, bounds.fallback)
  } catch {
    return bounds.fallback
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    return bounds.fallback
  }
  return value
}

export const readPortConfig = (window: unknown, key: string, fallback: number): number =>
  readIntConfig(window, key, { fallback, min: 1, max: 65535 })

/**
 * A plain string setting, or undefined when poi has none (or is absent).
 * Callers decide what the string is allowed to mean.
 */
export function readStringConfig(window: unknown, key: string): string | undefined {
  const get = asPoiWindow(window).config?.get
  if (typeof get !== 'function') {
    return undefined
  }

  let value: unknown
  try {
    value = (get as (path: string, fallback: unknown) => unknown)(key, undefined)
  } catch {
    return undefined
  }

  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Persist a setting in poi's own config. Best-effort: a poi without
 * `config.set` (or one that throws) just means the setting won't be
 * remembered, which is never worth failing the caller over.
 */
export function writeStringConfig(window: unknown, key: string, value: string): void {
  const set = asPoiWindow(window).config?.set
  if (typeof set !== 'function') {
    return
  }
  try {
    ;(set as (path: string, value: unknown) => unknown)(key, value)
  } catch {
    // Ignored on purpose — see above.
  }
}
