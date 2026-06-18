import {
  type GraphQLArgument,
  type GraphQLInputField,
  type GraphQLInputType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
} from 'graphql'
import { z } from 'zod'

/**
 * Custom scalar overrides keyed by GraphQL scalar name.
 */
export type ScalarMap = Record<string, z.ZodType | undefined>

/**
 * Builds the full input schema for a GraphQL field's variables object.
 */
export function createInputSchema(args: readonly GraphQLArgument[], scalars: ScalarMap = {}) {
  const shape: Record<string, z.ZodType> = {}
  for (const arg of args) shape[arg.name] = toInputFieldSchema(arg, scalars)
  return z.object(shape)
}

/**
 * Builds the positional-args schema for configured field arguments.
 */
export function createArgsSchema(
  args: readonly GraphQLArgument[],
  positionals: string[],
  scalars: ScalarMap = {},
) {
  if (positionals.length === 0) return undefined
  const shape: Record<string, z.ZodType> = {}
  for (const name of positionals) {
    const arg = args.find((entry) => entry.name === name)
    if (!arg) throw new Error(`Unknown GraphQL positional argument '${name}'`)
    if (!isPositionalType(arg.type))
      throw new Error(`GraphQL argument '${name}' cannot be positional`)
    shape[name] = toInputFieldSchema(arg, scalars)
  }
  return z.object(shape)
}

/**
 * Builds the options schema for flaggable, non-positional GraphQL arguments.
 */
export function createOptionsSchema(
  args: readonly GraphQLArgument[],
  positionals: string[],
  scalars: ScalarMap = {},
) {
  const excluded = new Set(positionals)
  const shape: Record<string, z.ZodType> = {}
  for (const arg of args) {
    if (excluded.has(arg.name) || !isFlaggableType(arg.type)) continue
    shape[arg.name] = toInputFieldSchema(arg, scalars)
  }
  return Object.keys(shape).length > 0 ? z.object(shape) : undefined
}

function toInputFieldSchema(
  field: GraphQLArgument | GraphQLInputField,
  scalars: ScalarMap,
): z.ZodType {
  return wrapOptional(field.type, toInputSchema(field.type, scalars))
}

function toInputSchema(type: GraphQLInputType, scalars: ScalarMap): z.ZodType {
  if (isNonNullType(type)) return toInputSchema(type.ofType, scalars)
  if (isListType(type)) return z.array(toInputSchema(type.ofType, scalars))
  if (isEnumType(type))
    return z.enum(type.getValues().map((value) => value.name) as [string, ...string[]])
  if (isInputObjectType(type)) {
    const shape: Record<string, z.ZodType> = {}
    for (const field of Object.values(type.getFields()))
      shape[field.name] = toInputFieldSchema(field, scalars)
    return z.object(shape)
  }
  if (isScalarType(type)) return scalarSchema(type.name, scalars)
  return z.unknown()
}

function wrapOptional(type: GraphQLInputType, schema: z.ZodType) {
  return isNonNullType(type) ? schema : schema.optional()
}

function isFlaggableType(type: GraphQLInputType): boolean {
  const current = isNonNullType(type) ? type.ofType : type
  if (isListType(current)) return isFlaggableType(current.ofType)
  return isEnumType(current) || isScalarType(current)
}

function isPositionalType(type: GraphQLInputType): boolean {
  const current = isNonNullType(type) ? type.ofType : type
  return isEnumType(current) || isScalarType(current)
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
