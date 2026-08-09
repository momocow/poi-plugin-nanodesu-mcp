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
  config?: { get?: unknown }
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

export function readPortConfig(window: unknown, key: string, fallback: number): number {
  const get = asPoiWindow(window).config?.get
  if (typeof get !== 'function') {
    return fallback
  }

  let value: unknown
  try {
    value = (get as (path: string, fallback: number) => unknown)(key, fallback)
  } catch {
    // A broken config read is never a reason not to start.
    return fallback
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65535) {
    return fallback
  }
  return value
}
