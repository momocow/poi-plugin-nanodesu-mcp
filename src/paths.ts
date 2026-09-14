export type PathSegment = string | number

export type ResolveResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Store roots that may be read. Everything else is refused before traversal.
 */
export const ALLOWED_ROOTS = [
  'info',
  'const',
  'fcd',
  'wctf',
  'battle',
  'sortie',
  'timers',
  'misc',
] as const

/**
 * Roots that are refused, and why. `layout` is the load-bearing one: it holds
 * `layout.webview.ref`, a live DOM element whose circular references make
 * JSON.stringify throw.
 */
export const DENIED_ROOTS: Record<string, string> = {
  layout: 'holds live DOM references that cannot be serialized',
  plugins: 'holds React component classes',
  ext: 'holds arbitrary plugin state with no serialization guarantees',
  config: 'may contain proxy credentials',
  ui: 'UI-local state, no game data',
}

export const EXT_ROOT = 'ext'

/**
 * Plugin state under `ext` that may be read, by poi package name (the key poi's
 * `extendReducer(plugin.packageName, ...)` mounts it under), and why it is safe.
 *
 * `ext` as a whole stays denied — its contents are whatever the installed
 * plugins happen to put there. Each entry here is the record that someone read
 * a specific plugin's reducers and found plain, serializable data, so adding
 * one is a deliberate act rather than a side effect of widening a path.
 *
 * Note the shape of what lies beneath: poi wraps every plugin reducer in
 * `combineReducers({ _: reducer })` (`views/redux/reducer-factory.js`, so that
 * a throwing plugin reducer is isolated), which puts the plugin's own state one
 * level down at `ext.<packageName>._`. That `_` is poi's, not the plugin's.
 */
export const ALLOWED_EXT_PLUGINS: Record<string, string> = {
  'poi-plugin-akashic-records':
    'sortie/mission/construction/scrap logs, held as arrays of strings and numbers',
  // The Logbook EX fork keeps the same reducer shape, plus a `quest` log.
  'poi-plugin-akashic-records-ex':
    'sortie/mission/construction/scrap/quest logs, held as arrays of strings and numbers',
}

const extPath = (plugin: string) => `${EXT_ROOT}.${plugin}`

const readableSummary = () =>
  [...ALLOWED_ROOTS, ...Object.keys(ALLOWED_EXT_PLUGINS).map(extPath)].join(', ')

/**
 * The readable branches actually present in a store: allowed roots, plus one
 * entry per allowlisted plugin that has state. Used to answer "what can I read"
 * without implying branches the running poi does not have.
 */
export function readableRoots(store: unknown): string[] {
  if (store === null || typeof store !== 'object') {
    return []
  }
  const container = store as Record<string, unknown>
  const roots: string[] = ALLOWED_ROOTS.filter((root) => root in container)

  const ext = container[EXT_ROOT]
  if (ext === null || typeof ext !== 'object') {
    return roots
  }
  const plugins = Object.keys(ALLOWED_EXT_PLUGINS)
    .filter((plugin) => plugin in (ext as Record<string, unknown>))
    .map(extPath)

  return [...roots, ...plugins]
}

const MAX_SUGGESTED_KEYS = 20

export function parseFieldPath(path: string): PathSegment[] {
  if (path.length === 0) {
    throw new Error('path is empty')
  }

  const segments: PathSegment[] = []
  let i = 0

  while (i < path.length) {
    if (path[i] === '[') {
      const close = path.indexOf(']', i)
      if (close === -1) {
        throw new Error(`unclosed '[' in path: ${path}`)
      }
      const inner = path.slice(i + 1, close)
      if (!/^\d+$/.test(inner)) {
        throw new Error(`array index must be an integer, got '[${inner}]' in path: ${path}`)
      }
      segments.push(Number(inner))
      i = close + 1
    } else {
      let end = i
      while (end < path.length && path[end] !== '.' && path[end] !== '[') {
        end++
      }
      const ident = path.slice(i, end)
      if (ident.length === 0) {
        throw new Error(`empty segment in path: ${path}`)
      }
      segments.push(ident)
      i = end
    }

    if (i < path.length && path[i] === '.') {
      i++
      if (i >= path.length) {
        throw new Error(`empty segment in path: ${path}`)
      }
    }
  }

  return segments
}

export function getByPath(value: unknown, segments: PathSegment[]): unknown {
  let current = value
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[String(segment)]
  }
  return current
}

/**
 * Resolve a dot path against the store, enforcing the root allowlist.
 *
 * A key that is present but holds `undefined` resolves successfully; only a
 * genuinely absent key is an error. That distinction is what lets callers tell
 * "you asked wrong" from "the game has not loaded yet".
 */
export function resolveStorePath(store: unknown, path: string): ResolveResult {
  let segments: PathSegment[]
  try {
    segments = parseFieldPath(path)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const root = String(segments[0])
  const allowed = readableSummary()

  if (root === EXT_ROOT) {
    // `ext` is readable only one allowlisted plugin at a time, never whole.
    const plugin = segments.length > 1 ? String(segments[1]) : undefined
    if (plugin === undefined) {
      return {
        ok: false,
        error: `root 'ext' cannot be read whole (${DENIED_ROOTS.ext}). Readable paths: ${allowed}`,
      }
    }
    if (!(plugin in ALLOWED_EXT_PLUGINS)) {
      return {
        ok: false,
        error: `plugin state '${extPath(plugin)}' is not exposed. Readable paths: ${allowed}`,
      }
    }
  } else {
    const deniedReason = DENIED_ROOTS[root]
    if (deniedReason !== undefined) {
      return {
        ok: false,
        error: `root '${root}' is not exposed (${deniedReason}). Allowed roots: ${allowed}`,
      }
    }

    if (!(ALLOWED_ROOTS as readonly string[]).includes(root)) {
      return { ok: false, error: `unknown root '${root}'. Allowed roots: ${allowed}` }
    }
  }

  let current: unknown = store
  const walked: PathSegment[] = []

  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      const where = walked.length > 0 ? walked.join('.') : '(root)'
      return { ok: false, error: `cannot descend into '${where}': it is not an object` }
    }

    const container = current as Record<string, unknown>
    const key = String(segment)

    if (!(key in container)) {
      const where = walked.length > 0 ? walked.join('.') : '(root)'
      const keys = Object.keys(container)
      const shown = keys.slice(0, MAX_SUGGESTED_KEYS).join(', ')
      const more = keys.length > MAX_SUGGESTED_KEYS ? `, ... (${keys.length} total)` : ''
      return { ok: false, error: `no key '${key}' at '${where}'. Available keys: ${shown}${more}` }
    }

    current = container[key]
    walked.push(segment)
  }

  return { ok: true, value: current }
}
