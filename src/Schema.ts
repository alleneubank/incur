import { z } from 'zod'

/**
 * Converts a Zod schema to a JSON Schema object. Strips the `$schema`
 * meta-property and zod registry (`~`) keys throughout the tree. Represents
 * bigints and dates as `{ type: "string" }` since JSON lacks native types for
 * them.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return stripMeta(
    z.toJSONSchema(schema, {
      unrepresentable: 'any',
      override: (ctx) => {
        const type = ctx.zodSchema._zod?.def?.type
        if (type === 'bigint' || type === 'date') ctx.jsonSchema.type = 'string'
      },
    }),
  ) as Record<string, unknown>
}

function stripMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMeta)
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value))
    if (k !== '$schema' && !k.startsWith('~')) result[k] = stripMeta(v)

  return result
}
