import type { DescEnum, DescField, DescMessage } from '@bufbuild/protobuf'
import { ScalarType } from '@bufbuild/protobuf'
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt'
import { z } from 'zod'

import { enumLiteral } from './Metadata.js'

/**
 * Builds the full input schema for a protobuf message.
 */
export function createInputSchema(message: DescMessage, required: Set<string>) {
  return createMessageSchema(message, 'input', required)
}

/**
 * Builds the output schema for a protobuf message.
 */
export function createOutputSchema(message: DescMessage) {
  return createMessageSchema(message, 'output', new Set())
}

/**
 * Builds the positional-args schema for the requested fields.
 */
export function createArgsSchema(message: DescMessage, positionals: string[]) {
  if (positionals.length === 0) return undefined
  const shape: Record<string, z.ZodType> = {}
  for (const name of positionals) {
    const field = message.field[name]
    if (!field) throw new Error(`Unknown positional field '${name}' on '${message.typeName}'`)
    if (!isFlaggableField(field))
      throw new Error(`Field '${name}' on '${message.typeName}' cannot be positional`)
    shape[name] = createFieldSchema(field, 'input', true)
  }
  return z.object(shape)
}

/**
 * Builds the options schema for flaggable, non-positional fields.
 */
export function createOptionsSchema(
  message: DescMessage,
  excluded: Set<string>,
  required: Set<string>,
) {
  const shape: Record<string, z.ZodType> = {}
  for (const field of message.fields) {
    if (excluded.has(field.localName) || !isFlaggableField(field)) continue
    shape[field.localName] = createFieldSchema(field, 'input', required.has(field.localName))
  }
  return Object.keys(shape).length > 0 ? z.object(shape) : undefined
}

/**
 * Resolves fields that must be present in input validation.
 */
export function createRequiredFields(message: DescMessage, positionals: string[]) {
  const required = new Set(positionals)
  for (const field of message.fields)
    if (field.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED) required.add(field.localName)
  return required
}

function createMessageSchema(
  message: DescMessage,
  mode: 'input' | 'output',
  required: Set<string>,
  cache = new Map<string, z.ZodObject<any>>(),
): z.ZodObject<any> {
  const key = `${mode}:${message.typeName}:${[...required].sort().join(',')}`
  const cached = cache.get(key)
  if (cached) return cached
  const shape: Record<string, z.ZodType> = {}
  const schema = z.object(shape).superRefine((value, ctx) => {
    for (const oneof of message.oneofs) {
      const present = oneof.fields.filter((field) => value[field.localName] !== undefined)
      if (present.length < 2) continue
      for (const field of present)
        ctx.addIssue({
          code: 'custom',
          message: `Only one of ${oneof.fields.map((item) => item.localName).join(', ')} may be set`,
          path: [field.localName],
        })
    }
  })
  cache.set(key, schema)
  for (const field of message.fields) {
    let fieldSchema = createFieldSchema(field, mode, required.has(field.localName), cache)
    if (mode === 'output' || !required.has(field.localName)) fieldSchema = fieldSchema.optional()
    shape[field.localName] = fieldSchema
  }
  return schema
}

function createFieldSchema(
  field: DescField,
  mode: 'input' | 'output',
  required: boolean,
  cache = new Map<string, z.ZodObject<any>>(),
): z.ZodType {
  const schema = (() => {
    switch (field.fieldKind) {
      case 'enum':
        return createEnumSchema(field.enum, mode)
      case 'list':
        return z.array(createListSchema(field, mode, cache))
      case 'map':
        return z.record(z.string(), createMapSchema(field, mode, cache))
      case 'message':
        return createMessageSchema(
          field.message,
          mode,
          mode === 'input' ? createRequiredFields(field.message, []) : new Set(),
          cache,
        )
      case 'scalar':
        return scalarToZod(field.scalar)
    }
  })()

  if (required) return schema
  return schema.optional()
}

function createListSchema(
  field: Extract<DescField, { fieldKind: 'list' }>,
  mode: 'input' | 'output',
  cache: Map<string, z.ZodObject<any>>,
) {
  switch (field.listKind) {
    case 'enum':
      return createEnumSchema(field.enum, mode)
    case 'message':
      return createMessageSchema(
        field.message,
        mode,
        mode === 'input' ? createRequiredFields(field.message, []) : new Set(),
        cache,
      )
    case 'scalar':
      return scalarToZod(field.scalar)
  }
}

function createMapSchema(
  field: Extract<DescField, { fieldKind: 'map' }>,
  mode: 'input' | 'output',
  cache: Map<string, z.ZodObject<any>>,
) {
  switch (field.mapKind) {
    case 'enum':
      return createEnumSchema(field.enum, mode)
    case 'message':
      return createMessageSchema(
        field.message,
        mode,
        mode === 'input' ? createRequiredFields(field.message, []) : new Set(),
        cache,
      )
    case 'scalar':
      return scalarToZod(field.scalar)
  }
}

function createEnumSchema(desc: DescEnum, mode: 'input' | 'output') {
  const values = desc.values
    .filter((value) => mode === 'output' || !value.name.endsWith('UNSPECIFIED'))
    .map((value) => enumLiteral(desc, value.name))
  return z.enum(values.length > 0 ? (values as [string, ...string[]]) : ['unspecified'])
}

function scalarToZod(type: ScalarType) {
  switch (type) {
    case ScalarType.BOOL:
      return z.boolean()
    case ScalarType.STRING:
      return z.string()
    case ScalarType.BYTES:
      return z
        .string()
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid base64')
        .refine(
          (value) =>
            value.length % 4 === 0 && Buffer.from(value, 'base64').toString('base64') === value,
          'Invalid base64 encoding',
        )
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return z
        .string()
        .regex(/^-?\d+$/)
        .refine((value) => {
          const n = BigInt(value)
          return n >= -9223372036854775808n && n <= 9223372036854775807n
        }, 'Out of int64 range')
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return z
        .string()
        .regex(/^\d+$/)
        .refine((value) => BigInt(value) <= 18446744073709551615n, 'Out of uint64 range')
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return z.number()
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      return z.number().int().min(-2147483648).max(2147483647)
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return z.number().int().min(0).max(4294967295)
  }
}

function isFlaggableField(field: DescField) {
  if (field.oneof) return true
  return field.fieldKind === 'enum' || field.fieldKind === 'list' || field.fieldKind === 'scalar'
}
