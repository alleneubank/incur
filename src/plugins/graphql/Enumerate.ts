import type { GraphQLField, GraphQLSchema } from 'graphql'

/**
 * A generated GraphQL root-field command.
 */
export type RootOperation = {
  commandName: string
  description?: string | undefined
  destructive?: boolean | undefined
  field: GraphQLField<any, any>
  kind: 'mutation' | 'query'
  mutates: boolean
  name: string
  positionals: string[]
}

/**
 * Enumerates query and mutation root fields as generated commands.
 */
export function enumerateOperations(
  schema: GraphQLSchema,
  options: {
    exclude?: string[] | undefined
    include?: string[] | undefined
    mutations?:
      | Record<
          string,
          { destructive?: boolean | undefined; mutates?: boolean | undefined } | undefined
        >
      | undefined
    positionals?: Record<string, string[] | undefined> | undefined
    rename?: Record<string, string | undefined> | undefined
  },
) {
  const operations: RootOperation[] = []
  const seen = new Set<string>()
  const include = options.include ? new Set(options.include) : undefined
  const exclude = new Set(options.exclude ?? [])

  for (const entry of [
    { kind: 'query', type: schema.getQueryType() },
    { kind: 'mutation', type: schema.getMutationType() },
  ] as const) {
    const fields = entry.type?.getFields() ?? {}
    for (const field of Object.values(fields)) {
      if (include && !include.has(field.name)) continue
      if (exclude.has(field.name)) continue

      const commandName = options.rename?.[field.name] ?? toKebab(field.name)
      if (seen.has(commandName)) throw new Error(`Duplicate GraphQL command name '${commandName}'`)
      seen.add(commandName)

      const mutation = options.mutations?.[field.name]
      operations.push({
        commandName,
        ...(field.description ? { description: field.description } : undefined),
        ...(mutation?.destructive ? { destructive: true } : undefined),
        field,
        kind: entry.kind,
        mutates: mutation?.mutates ?? entry.kind === 'mutation',
        name: field.name,
        positionals: options.positionals?.[field.name] ?? [],
      })
    }
  }

  return operations
}

function toKebab(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase()
}
