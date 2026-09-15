/**
 * Adapter over poi's i18n. Mirrors src/poi.ts: read window globals rather than
 * import poi's internal modules (e.g. `views/env-parts/i18next`), which export
 * nothing in the released build — see the comment on src/poi.ts for the same
 * problem with `getStore`/`isMain`.
 *
 * poi loads `i18n/<locale>.json` from the plugin root and registers it as an
 * i18next namespace named after `poiPlugin.id`, exposing a `__(str)`
 * translator at `window.i18n[namespace]` that falls back to `str` untranslated
 * when no i18n directory was found or no entry matches. NAMESPACE must match
 * `poiPlugin.id` in package.json.
 */

export const NAMESPACE = 'poi_nanodesu_mcp'

type PoiWindow = {
  i18n?: Record<string, { __?: unknown }>
}

const asPoiWindow = (value: unknown): PoiWindow =>
  value !== null && typeof value === 'object' ? (value as PoiWindow) : {}

export function translate(window: unknown, str: string): string {
  const __ = asPoiWindow(window).i18n?.[NAMESPACE]?.__
  return typeof __ === 'function' ? (__ as (s: string) => string)(str) : str
}
