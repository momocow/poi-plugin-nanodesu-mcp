import { getByPath, parseFieldPath, type PathSegment } from './paths.ts'

export type QueryOptions = {
  where?: string
  select?: string[]
  limit?: number
  treatAs?: 'collection' | 'value'
}

export type QueryResult =
  | {
      kind: 'object-map'
      total: number
      returned: number
      truncated: boolean
      items: Record<string, unknown>
    }
  | { kind: 'array'; total: number; returned: number; truncated: boolean; items: unknown[] }
  | { kind: 'object'; value: unknown }
  | { kind: 'scalar'; value: unknown }

/**
 * A collection is an array, or an object whose keys are all integer-like.
 *
 * This is what separates `info.ships` (keyed by id) from `info.basic` (keyed by
 * api_member_id, api_nickname, ...) — both are plain objects, so the shape
 * alone cannot tell them apart. An empty object is a collection: the rule holds
 * vacuously, and an empty map is more useful reported as zero elements.
 */
export function isCollection(value: unknown): boolean {
  if (Array.isArray(value)) {
    return true
  }
  if (value === null || typeof value !== 'object') {
    return false
  }
  return Object.keys(value).every((key) => /^\d+$/.test(key))
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type CompareOp = '=' | '==' | '!=' | '<' | '<=' | '>' | '>='
type Keyword = 'and' | 'or' | 'not' | 'in' | 'contains' | 'exists'

type Token =
  | { type: 'field'; path: PathSegment[]; text: string; pos: number }
  | { type: 'number'; value: number; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'literal'; value: boolean | null; pos: number }
  | { type: 'keyword'; value: Keyword; pos: number }
  | { type: 'op'; value: CompareOp; pos: number }
  | { type: 'punct'; value: '(' | ')' | '[' | ']' | ','; pos: number }

const KEYWORDS = new Set<string>(['and', 'or', 'not', 'in', 'contains', 'exists'])

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c)
const isDigit = (c: string) => c >= '0' && c <= '9'

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expr.length) {
    const c = expr[i] as string

    if (/\s/.test(c)) {
      i++
      continue
    }

    if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',') {
      tokens.push({ type: 'punct', value: c, pos: i })
      i++
      continue
    }

    if (c === '"' || c === "'") {
      const start = i
      const quote = c
      i++
      let out = ''
      let closed = false
      while (i < expr.length) {
        const ch = expr[i] as string
        if (ch === '\\' && i + 1 < expr.length) {
          out += expr[i + 1]
          i += 2
          continue
        }
        if (ch === quote) {
          closed = true
          i++
          break
        }
        out += ch
        i++
      }
      if (!closed) {
        throw new Error(`unterminated string starting at position ${start}`)
      }
      tokens.push({ type: 'string', value: out, pos: start })
      continue
    }

    if (isDigit(c) || (c === '-' && isDigit(expr[i + 1] ?? ''))) {
      const start = i
      if (c === '-') {
        i++
      }
      while (i < expr.length && isDigit(expr[i] as string)) {
        i++
      }
      if (expr[i] === '.' && isDigit(expr[i + 1] ?? '')) {
        i++
        while (i < expr.length && isDigit(expr[i] as string)) {
          i++
        }
      }
      tokens.push({ type: 'number', value: Number(expr.slice(start, i)), pos: start })
      continue
    }

    const two = expr.slice(i, i + 2)
    if (two === '!=' || two === '==' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two, pos: i })
      i += 2
      continue
    }
    if (c === '=' || c === '<' || c === '>') {
      tokens.push({ type: 'op', value: c, pos: i })
      i++
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      while (i < expr.length && isIdentPart(expr[i] as string)) {
        i++
      }
      // Greedily absorb `.ident` and `[digits]` so a fieldpath lexes as one
      // token; an unattached `[` therefore always starts an array literal.
      for (;;) {
        if (expr[i] === '.' && isIdentStart(expr[i + 1] ?? '')) {
          i++
          while (i < expr.length && isIdentPart(expr[i] as string)) {
            i++
          }
          continue
        }
        if (expr[i] === '[') {
          const close = expr.indexOf(']', i)
          if (close !== -1 && /^\d+$/.test(expr.slice(i + 1, close))) {
            i = close + 1
            continue
          }
        }
        break
      }

      const text = expr.slice(start, i)
      if (KEYWORDS.has(text)) {
        tokens.push({ type: 'keyword', value: text as Keyword, pos: start })
      } else if (text === 'true' || text === 'false') {
        tokens.push({ type: 'literal', value: text === 'true', pos: start })
      } else if (text === 'null') {
        tokens.push({ type: 'literal', value: null, pos: start })
      } else {
        tokens.push({ type: 'field', path: parseFieldPath(text), text, pos: start })
      }
      continue
    }

    throw new Error(`unexpected character '${c}' at position ${i}`)
  }

  return tokens
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Operand =
  | { kind: 'field'; path: PathSegment[] }
  | { kind: 'literal'; value: unknown }
  | { kind: 'array'; items: Operand[] }

type Node =
  | { kind: 'or'; left: Node; right: Node }
  | { kind: 'and'; left: Node; right: Node }
  | { kind: 'not'; operand: Node }
  | { kind: 'exists'; path: PathSegment[] }
  | { kind: 'compare'; op: CompareOp; left: Operand; right: Operand }
  | { kind: 'in'; left: Operand; right: Operand }
  | { kind: 'contains'; left: Operand; right: Operand }

const GRAMMAR_HINT =
  "expected: <field> <op> <value>, combined with and/or/not, e.g. 'api_nowhp < api_maxhp'"

class Parser {
  private index = 0

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  parse(): Node {
    const node = this.parseOr()
    const extra = this.peek()
    if (extra) {
      throw new Error(`unexpected token at position ${extra.pos}. ${GRAMMAR_HINT}`)
    }
    return node
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private next(): Token | undefined {
    return this.tokens[this.index++]
  }

  private endPos(): number {
    return this.source.length
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    for (;;) {
      const token = this.peek()
      if (token?.type === 'keyword' && token.value === 'or') {
        this.next()
        left = { kind: 'or', left, right: this.parseAnd() }
        continue
      }
      return left
    }
  }

  private parseAnd(): Node {
    let left = this.parseNot()
    for (;;) {
      const token = this.peek()
      if (token?.type === 'keyword' && token.value === 'and') {
        this.next()
        left = { kind: 'and', left, right: this.parseNot() }
        continue
      }
      return left
    }
  }

  private parseNot(): Node {
    const token = this.peek()
    if (token?.type === 'keyword' && token.value === 'not') {
      this.next()
      return { kind: 'not', operand: this.parseNot() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Node {
    const token = this.peek()
    if (token?.type === 'punct' && token.value === '(') {
      this.next()
      const inner = this.parseOr()
      const close = this.peek()
      if (!(close?.type === 'punct' && close.value === ')')) {
        throw new Error(`expected ')' at position ${close?.pos ?? this.endPos()}`)
      }
      this.next()
      return inner
    }
    return this.parseComparison()
  }

  private parseComparison(): Node {
    const token = this.next()
    if (!token) {
      throw new Error(`unexpected end of expression at position ${this.endPos()}. ${GRAMMAR_HINT}`)
    }
    if (token.type !== 'field') {
      throw new Error(`expected a field name at position ${token.pos}. ${GRAMMAR_HINT}`)
    }

    const left: Operand = { kind: 'field', path: token.path }
    const op = this.peek()

    if (op?.type === 'keyword' && op.value === 'exists') {
      this.next()
      return { kind: 'exists', path: token.path }
    }
    if (op?.type === 'keyword' && (op.value === 'in' || op.value === 'contains')) {
      this.next()
      return { kind: op.value, left, right: this.parseOperand() }
    }
    if (op?.type !== 'op') {
      throw new Error(
        `expected an operator after '${token.text}' at position ${op?.pos ?? this.endPos()}. ${GRAMMAR_HINT}`,
      )
    }

    this.next()
    return { kind: 'compare', op: op.value, left, right: this.parseOperand() }
  }

  private parseOperand(): Operand {
    const token = this.next()
    if (!token) {
      throw new Error(`unexpected end of expression at position ${this.endPos()}. ${GRAMMAR_HINT}`)
    }

    switch (token.type) {
      case 'number':
      case 'string':
        return { kind: 'literal', value: token.value }
      case 'literal':
        return { kind: 'literal', value: token.value }
      case 'field':
        return { kind: 'field', path: token.path }
      case 'punct': {
        if (token.value !== '[') {
          break
        }
        const items: Operand[] = []
        for (;;) {
          const ahead = this.peek()
          if (ahead?.type === 'punct' && ahead.value === ']') {
            this.next()
            return { kind: 'array', items }
          }
          items.push(this.parseOperand())
          const sep = this.peek()
          if (sep?.type === 'punct' && sep.value === ',') {
            this.next()
            continue
          }
          if (sep?.type === 'punct' && sep.value === ']') {
            this.next()
            return { kind: 'array', items }
          }
          throw new Error(`expected ',' or ']' at position ${sep?.pos ?? this.endPos()}`)
        }
      }
    }

    throw new Error(`expected a value at position ${token.pos}. ${GRAMMAR_HINT}`)
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evalOperand(operand: Operand, row: unknown): unknown {
  switch (operand.kind) {
    case 'field':
      return getByPath(row, operand.path)
    case 'literal':
      return operand.value
    case 'array':
      return operand.items.map((item) => evalOperand(item, row))
  }
}

function compare(op: CompareOp, left: unknown, right: unknown): boolean {
  // Any comparison involving an undefined operand is false. A typo'd field
  // matches nothing rather than erroring or matching everything.
  if (left === undefined || right === undefined) {
    return false
  }

  switch (op) {
    case '=':
    case '==':
      return left === right
    case '!=':
      return left !== right
    default:
      break
  }

  const ordered =
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'string' && typeof right === 'string')
  if (!ordered) {
    return false
  }

  switch (op) {
    case '<':
      return (left as number) < (right as number)
    case '<=':
      return (left as number) <= (right as number)
    case '>':
      return (left as number) > (right as number)
    case '>=':
      return (left as number) >= (right as number)
  }
}

function evalNode(node: Node, row: unknown): boolean {
  switch (node.kind) {
    case 'or':
      return evalNode(node.left, row) || evalNode(node.right, row)
    case 'and':
      return evalNode(node.left, row) && evalNode(node.right, row)
    case 'not':
      return !evalNode(node.operand, row)
    case 'exists':
      return getByPath(row, node.path) !== undefined
    case 'compare':
      return compare(node.op, evalOperand(node.left, row), evalOperand(node.right, row))
    case 'in': {
      const left = evalOperand(node.left, row)
      const right = evalOperand(node.right, row)
      if (left === undefined || !Array.isArray(right)) {
        return false
      }
      return right.includes(left)
    }
    case 'contains': {
      const left = evalOperand(node.left, row)
      const right = evalOperand(node.right, row)
      if (right === undefined || !Array.isArray(left)) {
        return false
      }
      return left.includes(right)
    }
  }
}

export function compileWhere(expr: string): (row: unknown) => boolean {
  const node = new Parser(tokenize(expr), expr).parse()
  return (row: unknown) => evalNode(node, row)
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function applySelect(row: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const value = getByPath(row, parseFieldPath(path))
    if (value !== undefined) {
      out[path] = value
    }
  }
  return out
}

export function applyQuery(value: unknown, options: QueryOptions): QueryResult {
  const treatAsCollection =
    options.treatAs === 'collection'
      ? true
      : options.treatAs === 'value'
        ? false
        : isCollection(value)

  if (!treatAsCollection) {
    const isObject = value !== null && typeof value === 'object'
    const projected = options.select && isObject ? applySelect(value, options.select) : value
    return isObject ? { kind: 'object', value: projected } : { kind: 'scalar', value: projected }
  }

  const { select, limit } = options
  const predicate = options.where ? compileWhere(options.where) : undefined
  const project = (row: unknown) => (select ? applySelect(row, select) : row)

  if (Array.isArray(value)) {
    const matched = predicate ? value.filter((row) => predicate(row)) : value
    const truncated = limit !== undefined && matched.length > limit
    const kept = truncated ? matched.slice(0, limit) : matched
    return {
      kind: 'array',
      total: value.length,
      returned: kept.length,
      truncated,
      items: kept.map(project),
    }
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const matched = predicate ? entries.filter(([, row]) => predicate(row)) : entries
  const truncated = limit !== undefined && matched.length > limit
  const kept = truncated ? matched.slice(0, limit) : matched

  const items: Record<string, unknown> = {}
  for (const [key, row] of kept) {
    items[key] = project(row)
  }

  return { kind: 'object-map', total: entries.length, returned: kept.length, truncated, items }
}
