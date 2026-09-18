import { ParseError } from './Errors.js'
import { isRecord } from './internal/helpers.js'

/** A single segment in a filter path: either a string key or an array slice. */
export type Segment = { key: string } | { start: number; end: number }

/** A filter path is an ordered list of segments to traverse. */
export type FilterPath = Segment[]

/** Parses a filter expression string into structured filter paths. */
export function parse(expression: string): FilterPath[] {
  const paths: FilterPath[] = []
  const tokens: string[] = []
  let current = ''
  let depth = 0

  // Split on commas, but commas inside [...] are part of a slice
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!
    if (ch === '[') depth++
    else if (ch === ']') depth--

    if (ch === ',' && depth === 0) {
      tokens.push(current)
      current = ''
    } else current += ch
  }
  if (current) tokens.push(current)

  for (const token of tokens) {
    const path: FilterPath = []
    let remaining = token

    while (remaining.length > 0) {
      const bracketIdx = remaining.indexOf('[')

      if (bracketIdx === -1) {
        // No more slices — split remaining by dots
        for (const part of remaining.split('.')) if (part) path.push({ key: part })
        break
      }

      // Parse dot-separated keys before the bracket
      const before = remaining.slice(0, bracketIdx)
      for (const part of before.split('.')) if (part) path.push({ key: part })

      const closeBracket = remaining.indexOf(']', bracketIdx)
      if (closeBracket === -1) throw invalidPath(token)
      path.push(parseSlice(remaining.slice(bracketIdx + 1, closeBracket), token))

      remaining = remaining.slice(closeBracket + 1)
      if (remaining.startsWith('.')) remaining = remaining.slice(1)
    }

    paths.push(path)
  }

  return paths
}

const integer = /^-?\d+$/

/** Parses the inside of `[...]`: `[]` every element, `[n]` one element, `[start,end]` a slice. */
function parseSlice(inner: string, token: string): Segment {
  if (inner === '') return { start: 0, end: Infinity }
  const bounds = inner.split(',')
  if (bounds.length > 2 || !bounds.every((bound) => integer.test(bound))) throw invalidPath(token)
  const start = Number(bounds[0])
  if (bounds.length === 2) return { start, end: Number(bounds[1]) }
  // `[-1]` is the last element; `slice(-1, 0)` would be empty.
  return { start, end: start === -1 ? Infinity : start + 1 }
}

function invalidPath(token: string): ParseError {
  return new ParseError({
    message: `Invalid --filter-output path "${token}": use key.sub, key[n], key[start,end], or key[]`,
  })
}

/** Applies parsed filter paths to a data value, returning a filtered copy. */
export function apply(data: unknown, paths: FilterPath[]): unknown {
  if (paths.length === 0) return data

  // Single key selecting a scalar → return the scalar directly
  if (paths.length === 1 && paths[0]!.length === 1 && 'key' in paths[0]![0]!) {
    const key = paths[0]![0]!.key
    if (Array.isArray(data)) return data.map((item) => apply(item, paths))
    if (typeof data === 'object' && data !== null) {
      const val = (data as Record<string, unknown>)[key]
      if (typeof val !== 'object' || val === null) return val
      return { [key]: val }
    }
    return undefined
  }

  if (Array.isArray(data)) return data.map((item) => apply(item, paths))

  const result: Record<string, unknown> = {}
  const positions: Positions = new WeakMap()
  for (const path of paths) merge(result, data, path, 0, positions)
  return result
}

/** Source index of each element of a filtered array, so later paths merge into the right element. */
type Positions = WeakMap<unknown[], number[]>

/** Returns warnings for filter paths that do not exist in a JSON Schema. */
export function validate(paths: FilterPath[], schema: Record<string, unknown>): string[] {
  return paths
    .filter((path) => !matchesSchema(schema, path))
    .map((path) => `Unknown field: ${formatPath(path)}`)
}

function merge(
  target: Record<string, unknown>,
  data: unknown,
  segments: Segment[],
  index: number,
  positions: Positions,
): void {
  if (index >= segments.length || typeof data !== 'object' || data === null) return
  const segment = segments[index]!

  if ('key' in segment) {
    const val = (data as Record<string, unknown>)[segment.key]
    if (val === undefined) return

    if (index + 1 >= segments.length) {
      target[segment.key] = val
      return
    }

    const next = segments[index + 1]!
    if ('start' in next) {
      // Next segment is a slice
      if (!Array.isArray(val)) return
      const selection = { source: val, indices: sliceIndices(val.length, next) }
      target[segment.key] = mergeItems(
        target[segment.key],
        selection,
        segments,
        index + 2,
        positions,
      )
      return
    }

    // Next segment is a key — recurse into nested object
    if (Array.isArray(val)) {
      const selection = { source: val, indices: val.map((_, at) => at) }
      target[segment.key] = mergeItems(
        target[segment.key],
        selection,
        segments,
        index + 1,
        positions,
      )
      return
    }

    if (typeof val !== 'object' || val === null) return
    if (!target[segment.key] || typeof target[segment.key] !== 'object') target[segment.key] = {}
    merge(target[segment.key] as Record<string, unknown>, val, segments, index + 1, positions)
    return
  }

  // slice at root level — shouldn't happen in merge (merge starts from object keys)
}

/** Source indices `Array.prototype.slice(start, end)` would select. */
function sliceIndices(length: number, slice: { start: number; end: number }): number[] {
  const bound = (value: number) => Math.min(Math.max(value < 0 ? length + value : value, 0), length)
  const from = bound(slice.start)
  const to = bound(slice.end)
  return Array.from({ length: Math.max(to - from, 0) }, (_, offset) => from + offset)
}

/**
 * Filters the selected elements and merges them, by source index, with what earlier paths
 * selected from the same array; a path that ends here selects whole elements.
 */
function mergeItems(
  existing: unknown,
  selection: { source: unknown[]; indices: number[] },
  segments: Segment[],
  index: number,
  positions: Positions,
): unknown[] {
  const bySource = new Map<number, unknown>()
  if (Array.isArray(existing)) {
    const known = positions.get(existing)
    existing.forEach((item, at) => bySource.set(known?.[at] ?? at, item))
  }
  for (const at of selection.indices) {
    const item = selection.source[at]
    if (index >= segments.length) {
      bySource.set(at, item)
      continue
    }
    const earlier = bySource.get(at)
    const sub: Record<string, unknown> = isRecord(earlier) ? { ...earlier } : {}
    merge(sub, item, segments, index, positions)
    bySource.set(at, sub)
  }
  const order = [...bySource.keys()].toSorted((a, b) => a - b)
  const merged = order.map((at) => bySource.get(at))
  positions.set(merged, order)
  return merged
}

function matchesSchema(schema: Record<string, unknown> | undefined, path: FilterPath): boolean {
  if (!schema) return true
  return walkSchema(schema, path, 0)
}

function walkSchema(
  schema: Record<string, unknown> | undefined,
  path: FilterPath,
  index: number,
): boolean {
  if (!schema) return false
  if (index >= path.length) return true

  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants))
    return variants.some((variant) =>
      walkSchema(variant as Record<string, unknown> | undefined, path, index),
    )

  const segment = path[index]!
  const type = schema.type as string | undefined
  // An unconstrained schema (`{}`, as `z.unknown()` emits) allows any path below it.
  if (type === undefined && !('properties' in schema) && !('additionalProperties' in schema))
    return true

  if ('start' in segment) {
    if (type !== 'array') return false
    return walkSchema(schema.items as Record<string, unknown> | undefined, path, index + 1)
  }

  if (type === 'array')
    return walkSchema(schema.items as Record<string, unknown> | undefined, path, index)

  if (type !== undefined && type !== 'object') return false
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  const prop = properties?.[segment.key]
  if (prop) return walkSchema(prop, path, index + 1)
  // Undeclared keys are unknown only where `additionalProperties: false` closes the object.
  const additional = schema.additionalProperties
  if (additional === false) return false
  if (typeof additional === 'object' && additional !== null)
    return walkSchema(additional as Record<string, unknown>, path, index + 1)
  return true
}

function formatPath(path: FilterPath): string {
  return path
    .map((segment) => ('key' in segment ? segment.key : formatSlice(segment)))
    .join('.')
    .replace('.[', '[')
}

function formatSlice(slice: { start: number; end: number }): string {
  if (slice.start === 0 && slice.end === Infinity) return '[]'
  if (slice.end === slice.start + 1 || (slice.start === -1 && slice.end === Infinity))
    return `[${slice.start}]`
  return `[${slice.start},${slice.end}]`
}
