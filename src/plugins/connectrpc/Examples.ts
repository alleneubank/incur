import type { DescField, DescMethod } from '@bufbuild/protobuf'
import { ScalarType } from '@bufbuild/protobuf'
import { z } from 'zod'

import { enumName, humanizeMethod } from './Metadata.js'

type Example = {
  args?: Record<string, unknown> | undefined
  description?: string | undefined
  options?: Record<string, unknown> | undefined
}

/**
 * Resolves example requests for generated Connect RPC methods.
 */
export function resolveExamples(
  method: DescMethod,
  args: z.ZodObject<any> | undefined,
  options: z.ZodObject<any> | undefined,
  examples: Example[] | undefined,
) {
  if (examples && examples.length > 0) return examples
  const example: Example = {}
  if (args) {
    const values: Record<string, unknown> = {}
    for (const key of Object.keys(args.shape)) {
      const field = method.input.field[key]
      if (!field) continue
      values[key] = sampleValue(field)
    }
    example.args = values
  } else if (options)
    for (const [key, value] of Object.entries(options.shape)) {
      if (value instanceof z.ZodArray) continue
      const field = method.input.field[key]
      if (!field) continue
      example.options = { [key]: sampleValue(field) }
      break
    }
  if (!example.args && !example.options) return undefined
  example.description = `Example ${humanizeMethod(method.name).toLowerCase()} request`
  return [example]
}

function sampleValue(field: DescField) {
  switch (field.fieldKind) {
    case 'enum':
      return enumName(field.enum, field.enum.values[1]?.number ?? 0)
    case 'list':
      return undefined
    case 'map':
      return {}
    case 'message':
      return {}
    case 'scalar':
      if (field.scalar === ScalarType.BOOL) return true
      if (
        field.scalar === ScalarType.STRING ||
        field.scalar === ScalarType.BYTES ||
        isInt64Scalar(field.scalar)
      )
        return field.localName === 'userId' ? 'u-123' : 'value'
      return 1
  }
}

function isInt64Scalar(type: ScalarType) {
  return [
    ScalarType.INT64,
    ScalarType.UINT64,
    ScalarType.FIXED64,
    ScalarType.SFIXED64,
    ScalarType.SINT64,
  ].includes(type)
}
