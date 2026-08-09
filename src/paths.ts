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
  const allowed = ALLOWED_ROOTS.join(', ')

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
