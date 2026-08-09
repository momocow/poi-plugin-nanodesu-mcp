import type { QueryResult } from './query.ts'

export type FitResult = { ok: true; payload: QueryResult } | { ok: false; error: string }

const DEFAULT_MAX_DEPTH = 16

/**
 * Make a value safe to JSON.stringify: functions dropped, cycles replaced,
 * depth capped.
 *
 * Cycle detection tracks the current ancestor chain rather than every value
 * seen, so a value referenced twice in different branches is emitted twice
 * instead of being wrongly reported as circular.
 */
export function toJsonSafe(value: unknown, maxDepth: number = DEFAULT_MAX_DEPTH): unknown {
  const ancestors = new Set<object>()

  const walk = (current: unknown, depth: number): unknown => {
    if (current === null) {
      return null
    }

    const type = typeof current
    if (type === 'function' || type === 'symbol' || type === 'undefined') {
      return undefined
    }
    if (type === 'bigint') {
      return (current as bigint).toString()
    }
    if (type !== 'object') {
      return type === 'number' && !Number.isFinite(current) ? null : current
    }

    const object = current as object
    if (ancestors.has(object)) {
      return '[Circular]'
    }
    if (depth >= maxDepth) {
      return '[MaxDepth]'
    }

    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        return object.map((item) => {
          const walked = walk(item, depth + 1)
          return walked === undefined ? null : walked
        })
      }

      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object)) {
        const walked = walk(item, depth + 1)
        if (walked !== undefined) {
          out[key] = walked
        }
      }
      return out
    } finally {
      ancestors.delete(object)
    }
  }

  return walk(value, 0)
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(toJsonSafe(value)) ?? 'null', 'utf8')
}

/**
 * Cap a result at `maxBytes`.
 *
 * Collections shed elements until they fit — that is the backstop that keeps a
 * generic tool from flooding an agent's context. A single value has nothing to
 * shed, so it is an error rather than a silent truncation.
 */
export function fitToBytes(result: QueryResult, maxBytes: number): FitResult {
  if (result.kind === 'object' || result.kind === 'scalar') {
    const payload: QueryResult = { ...result, value: toJsonSafe(result.value) }
    const size = jsonByteLength(payload)
    if (size > maxBytes) {
      return {
        ok: false,
        error:
          `result is ${size} bytes, over the ${maxBytes} byte cap. ` +
          `Use a narrower path or a select to reduce it.`,
      }
    }
    return { ok: true, payload }
  }

  const build: (count: number) => QueryResult =
    result.kind === 'object-map'
      ? (() => {
          const entries = Object.entries(result.items).map(
            ([key, value]) => [key, toJsonSafe(value)] as const,
          )
          return (count: number) => ({
            ...result,
            returned: count,
            truncated: result.truncated || count < entries.length,
            items: Object.fromEntries(entries.slice(0, count)),
          })
        })()
      : (() => {
          const items = result.items.map((item) => toJsonSafe(item))
          return (count: number) => ({
            ...result,
            returned: count,
            truncated: result.truncated || count < items.length,
            items: items.slice(0, count),
          })
        })()

  const count = result.kind === 'object-map' ? Object.keys(result.items).length : result.items.length

  if (jsonByteLength(build(count)) <= maxBytes) {
    return { ok: true, payload: build(count) }
  }

  // Largest prefix that fits. Bottoms out at zero elements, which is still a
  // useful answer: total tells the caller what they missed.
  let low = 0
  let high = count
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonByteLength(build(mid)) <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }

  return { ok: true, payload: build(low) }
}
