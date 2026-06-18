import { z } from 'zod'

import * as Cli from '../Cli.js'
import { IncurError } from '../Errors.js'
import { mountOperations } from '../internal/generated/Mount.js'
import type { Operation } from '../internal/generated/Operation.js'
import type { Plugin } from '../Plugin.js'
import { enumerateOperations } from './graphql/Enumerate.js'
import { resolveDocument, parseVariables } from './graphql/Raw.js'
import { loadSchema, type SchemaSource } from './graphql/Schema.js'
import { createSelection } from './graphql/Selection.js'
import { createArgsSchema, createInputSchema, createOptionsSchema } from './graphql/Types.js'

/**
 * Transport configuration for generated GraphQL commands.
 */
export type Transport = {
  /**
   * Per-call headers.
   */
  headers?: (() => HeadersInit | Promise<HeadersInit>) | undefined
  /**
   * GraphQL endpoint URL.
   */
  url: string
}

/**
 * Safety metadata overrides for generated mutation commands.
 */
export type Mutation = {
  /**
   * Whether the command is destructive.
   */
  destructive?: boolean | undefined
  /**
   * Whether the command mutates remote state.
   */
  mutates?: boolean | undefined
}

/**
 * Options for the first-party GraphQL plugin.
 */
export type Options = {
  /**
   * Root field names to exclude from generation.
   */
  exclude?: string[] | undefined
  /**
   * Root field names to include. Omit to include every root field.
   */
  include?: string[] | undefined
  /**
   * Mutation safety overrides keyed by root field name.
   */
  mutations?: Record<string, Mutation | undefined> | undefined
  /**
   * Positional argument names keyed by root field name.
   */
  positionals?: Record<string, string[] | undefined> | undefined
  /**
   * CLI name overrides keyed by root field name.
   */
  rename?: Record<string, string | undefined> | undefined
  /**
   * Scalar Zod overrides keyed by scalar name.
   */
  scalars?: Record<string, z.ZodType | undefined> | undefined
  /**
   * GraphQL introspection, SDL, or prebuilt schema artifact.
   */
  schema: SchemaSource
  /**
   * Selection synthesis settings.
   */
  selection?:
    | {
        depth?: number | undefined
      }
    | undefined
  /**
   * GraphQL transport configuration.
   */
  transport: Transport
}

const schemaValue = z.custom<SchemaSource>()

const optionsSchema = z.object({
  exclude: z.array(z.string()).optional(),
  include: z.array(z.string()).optional(),
  mutations: z
    .record(
      z.string(),
      z.object({
        destructive: z.boolean().optional(),
        mutates: z.boolean().optional(),
      }),
    )
    .optional(),
  positionals: z.record(z.string(), z.array(z.string())).optional(),
  rename: z.record(z.string(), z.string()).optional(),
  scalars: z.record(z.string(), z.custom<z.ZodType>()).optional(),
  schema: schemaValue,
  selection: z
    .object({
      depth: z.number().optional(),
    })
    .optional(),
  transport: z.object({
    headers: z.custom<Transport['headers']>().optional(),
    url: z.string().url(),
  }),
})

/**
 * Creates a generator-style plugin from GraphQL schema artifacts.
 */
export function graphql(options: Options): Plugin<typeof optionsSchema> {
  return {
    name: 'graphql',
    description: 'Generate incur commands from GraphQL schema artifacts',
    config: optionsSchema,
    options: options as z.input<typeof optionsSchema>,
    async resolve({ config, mount }) {
      const cli = Cli.create(mount, {
        description: 'Generated GraphQL commands',
      })
      const schema = loadSchema(config.schema)
      const operations = enumerateOperations(schema, {
        exclude: config.exclude,
        include: config.include,
        mutations: config.mutations,
        positionals: config.positionals,
        rename: config.rename,
      }).map((operation) =>
        createGeneratedOperation({
          operation,
          scalars: config.scalars ?? {},
          selectionDepth: config.selection?.depth,
          transport: config.transport,
        }),
      )

      if (operations.some((operation) => operation.name === 'raw'))
        throw new Error(`Duplicate GraphQL command name 'raw'`)

      operations.push(createRawOperation(config.transport))
      mountOperations(Cli.toCommands.get(cli)!, operations)
      return cli
    },
  }
}

function createGeneratedOperation(options: {
  operation: ReturnType<typeof enumerateOperations>[number]
  scalars: Record<string, z.ZodType | undefined>
  selectionDepth?: number | undefined
  transport: z.output<typeof optionsSchema>['transport']
}): Operation<any, any, any> {
  const args = createArgsSchema(
    options.operation.field.args,
    options.operation.positionals,
    options.scalars,
  )
  const input = createInputSchema(options.operation.field.args, options.scalars)
  const commandOptions = createOptionsSchema(
    options.operation.field.args,
    options.operation.positionals,
    options.scalars,
  )
  const selection = createSelection(options.operation.field.type, {
    depth: options.selectionDepth,
    scalars: options.scalars,
  })
  const operationName = toOperationName(options.operation.name)
  const document = buildDocument({
    fieldName: options.operation.name,
    kind: options.operation.kind,
    operationName,
    rootArgs: options.operation.field.args.map((arg) => ({
      name: arg.name,
      type: String(arg.type),
    })),
    selection: selection.selection,
  })

  return {
    ...(args ? { args } : undefined),
    description: options.operation.description,
    ...(options.operation.destructive ? { destructive: true } : undefined),
    extensions: {
      graphql: {
        field: options.operation.name,
        operation: options.operation.kind,
      },
    },
    input,
    kind: options.operation.kind,
    ...(options.operation.mutates ? { mutates: true } : undefined),
    name: options.operation.commandName,
    ...(commandOptions ? { options: commandOptions } : undefined),
    output: selection.schema,
    run: async (context: any) => {
      try {
        const variables = input.parse({ ...context.options, ...context.args })
        const data = await execute({
          document,
          operationName,
          transport: options.transport,
          variables,
        })
        return (data as Record<string, unknown>)[options.operation.name]
      } catch (error) {
        return context.error(toError(error))
      }
    },
  }
}

function createRawOperation(
  transport: z.output<typeof optionsSchema>['transport'],
): Operation<any, any, any> {
  const optionsSchema = z.object({
    file: z.string().optional(),
    operationName: z.string().optional(),
    query: z.string().optional(),
    variables: z.string().optional(),
  })

  return {
    description: 'Execute an arbitrary GraphQL document',
    extensions: {
      graphql: {
        operation: 'raw',
      },
    },
    kind: 'raw',
    mutates: true,
    name: 'raw',
    options: optionsSchema,
    output: z.record(z.string(), z.unknown()),
    run: async (context: any) => {
      try {
        const parsed = optionsSchema.parse(context.options)
        const document = await resolveDocument({
          file: parsed.file,
          parseMode: context.parseMode,
          query: parsed.query,
        })
        const operationName = parsed.operationName
        const data = await execute({
          document,
          operationName,
          transport,
          variables: parseVariables(parsed.variables),
        })
        return data
      } catch (error) {
        return context.error(toError(error))
      }
    },
  }
}

async function execute(options: {
  document: string
  operationName?: string | undefined
  transport: z.output<typeof optionsSchema>['transport']
  variables?: Record<string, unknown> | undefined
}) {
  const headers = options.transport.headers ? await options.transport.headers() : undefined
  const response = await fetch(options.transport.url, {
    body: JSON.stringify({
      operationName: options.operationName,
      query: options.document,
      variables: options.variables,
    }),
    headers: {
      'content-type': 'application/json',
      ...(headers ? Object.fromEntries(new Headers(headers).entries()) : {}),
    },
    method: 'POST',
  })

  if (!response.ok)
    throw new IncurError({
      code: 'GRAPHQL_REQUEST_FAILED',
      message: `GraphQL request failed with status ${response.status}`,
      retryable: response.status >= 500,
    })

  const payload = (await response.json()) as {
    data?: Record<string, unknown> | undefined
    errors?: { message?: string | undefined }[] | undefined
  }

  if (payload.errors && payload.errors.length > 0)
    throw new IncurError({
      code: 'GRAPHQL_OPERATION_FAILED',
      message: payload.errors[0]?.message ?? 'GraphQL operation failed',
    })

  return payload.data ?? {}
}

function buildDocument(options: {
  fieldName: string
  kind: 'mutation' | 'query'
  operationName: string
  rootArgs: { name: string; type: string }[]
  selection?: string | undefined
}) {
  const variables = options.rootArgs.map((arg) => `$${arg.name}: ${arg.type}`).join(', ')
  const callArgs = options.rootArgs.map((arg) => `${arg.name}: $${arg.name}`).join(', ')
  const field = [
    options.fieldName,
    callArgs ? `(${callArgs})` : '',
    options.selection ? ` { ${options.selection} }` : '',
  ].join('')

  return `${options.kind} ${options.operationName}${variables ? `(${variables})` : ''} { ${field} }`
}

function toError(error: unknown) {
  if (error instanceof IncurError)
    return {
      code: error.code,
      message: error.message,
      ...(error.retryable !== undefined ? { retryable: error.retryable } : undefined),
    }

  return {
    code: 'GRAPHQL_OPERATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

function toOperationName(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
