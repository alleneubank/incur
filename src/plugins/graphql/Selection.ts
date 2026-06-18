import {
  type GraphQLOutputType,
  getNamedType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql'
import { z } from 'zod'

import type { ScalarMap } from './Types.js'

/**
 * Selection synthesis settings.
 */
export type Options = {
  depth?: number | undefined
  scalars?: ScalarMap | undefined
}

/**
 * Builds a deterministic default selection set and matching output schema.
 */
export function createSelection(type: GraphQLOutputType, options: Options = {}) {
  const result = visit(type, options.depth ?? 1, options.scalars ?? {})
  return {
    schema: result.schema,
    selection: result.selection,
  }
}

function visit(
  type: GraphQLOutputType,
  depth: number,
  scalars: ScalarMap,
): {
  schema: z.ZodType
  selection?: string | undefined
} {
  if (isNonNullType(type)) return visit(type.ofType, depth, scalars)
  if (isListType(type)) {
    const inner = visit(type.ofType, depth, scalars)
    return {
      schema: z.array(inner.schema).nullable(),
      ...(inner.selection ? { selection: inner.selection } : undefined),
    }
  }

  const named = getNamedType(type)
  if (isScalarType(named))
    return {
      schema: scalarSchema(named.name, scalars).nullable(),
    }
  if (isEnumType(named))
    return {
      schema: z
        .enum(named.getValues().map((value) => value.name) as [string, ...string[]])
        .nullable(),
    }
  if (isInterfaceType(named) || isUnionType(named))
    return {
      schema: z.object({ __typename: z.string() }).nullable(),
      selection: '__typename',
    }
  if (!isObjectType(named)) return { schema: z.unknown().nullable() }

  const shape: Record<string, z.ZodType> = {}
  const selected: string[] = []

  for (const field of Object.values(named.getFields())) {
    const current = getNamedType(field.type)
    if (isScalarType(current) || isEnumType(current)) {
      shape[field.name] = visit(field.type, depth, scalars).schema
      selected.push(field.name)
      continue
    }
    if (depth <= 0) continue
    const nested = visit(field.type, depth - 1, scalars)
    if (!nested.selection) continue
    shape[field.name] = nested.schema
    selected.push(`${field.name} { ${nested.selection} }`)
  }

  if (!selected.includes('id')) {
    const idField = named.getFields().id
    if (idField) {
      shape.id = visit(idField.type, depth, scalars).schema
      selected.unshift('id')
    }
  }

  if (selected.length === 0) {
    shape.__typename = z.string().nullable()
    selected.push('__typename')
  }

  return {
    schema: z.object(shape).nullable(),
    selection: selected.join(' '),
  }
}

function scalarSchema(name: string, scalars: ScalarMap) {
  const custom = scalars[name]
  if (custom) return custom
  switch (name) {
    case 'Boolean':
      return z.boolean()
    case 'Float':
    case 'Int':
      return z.number()
    case 'ID':
    case 'String':
      return z.string()
    default:
      return z.string()
  }
}
