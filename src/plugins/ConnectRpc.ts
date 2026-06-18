import type { DescMethod, DescService } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
import { createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node'
import { z } from 'zod'

import * as Cli from '../Cli.js'
import { mountOperations } from '../internal/generated/Mount.js'
import type { Operation } from '../internal/generated/Operation.js'
import type { Plugin } from '../Plugin.js'
import { mapRpcError, toPlainMessage, toProtoInput } from './connectrpc/Codec.js'
import { resolveExamples } from './connectrpc/Examples.js'
import {
  buildExtensions,
  buildHint,
  humanizeMethod,
  resolveMutation,
  toKebab,
} from './connectrpc/Metadata.js'
import {
  createArgsSchema,
  createInputSchema,
  createOptionsSchema,
  createOutputSchema,
  createRequiredFields,
} from './connectrpc/Schema.js'

/**
 * Transport configuration for generated Connect RPC commands.
 */
export type Transport = {
  /**
   * Base URL for the backend.
   */
  baseUrl: string
  /**
   * Per-call headers.
   */
  headers?: (() => HeadersInit | Promise<HeadersInit>) | undefined
  /**
   * Wire protocol used by the client.
   */
  protocol: 'connect' | 'grpc'
}

/**
 * Mutation metadata overrides for a generated method.
 */
export type Mutation = {
  /**
   * Whether the method mutates remote state.
   */
  mutates?: boolean | undefined
  /**
   * Whether the method is destructive.
   */
  destructive?: boolean | undefined
}

/**
 * Example override for a generated method.
 */
export type Example = {
  /**
   * Positional example arguments.
   */
  args?: Record<string, unknown> | undefined
  /**
   * Example description.
   */
  description?: string | undefined
  /**
   * Example named options.
   */
  options?: Record<string, unknown> | undefined
}

/**
 * Options for the first-party Connect RPC plugin.
 */
export type Options = {
  /**
   * Example overrides keyed by method local name.
   */
  examples?: Record<string, Example[] | undefined> | undefined
  /**
   * Mutation overrides keyed by method local name.
   */
  mutations?: Record<string, Mutation | undefined> | undefined
  /**
   * Positional field names keyed by method local name.
   */
  positionals?: Record<string, string[] | undefined> | undefined
  /**
   * CLI name overrides keyed by method local name.
   */
  rename?: Record<string, string | undefined> | undefined
  /**
   * Generated service descriptor.
   */
  service: DescService
  /**
   * Network transport configuration.
   */
  transport: Transport
}

const optionsSchema = z.object({
  examples: z.record(z.string(), z.custom<Example[]>()).optional(),
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
  service: z.custom<DescService>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'methods' in value &&
      Array.isArray((value as DescService).methods),
  ),
  transport: z.object({
    baseUrl: z.string().min(1),
    headers: z.custom<Transport['headers']>().optional(),
    protocol: z.enum(['connect', 'grpc']),
  }),
})

/**
 * Creates a generator-style plugin from generated Connect service artifacts.
 */
export function connectRpc(options: Options): Plugin<typeof optionsSchema> {
  return {
    name: 'connectRpc',
    description: 'Generate incur commands from Connect service descriptors',
    config: optionsSchema,
    options: options as z.input<typeof optionsSchema>,
    async resolve({ config, mount }) {
      const cli = Cli.create(mount, {
        description: `Generated RPC commands for ${config.service.typeName}`,
      })
      const transport =
        config.transport.protocol === 'grpc'
          ? createGrpcTransport({ baseUrl: config.transport.baseUrl })
          : createConnectTransport({ baseUrl: config.transport.baseUrl, httpVersion: '1.1' })
      const client = createClient(config.service, transport) as Record<string, Function>

      mountOperations(
        Cli.toCommands.get(cli)!,
        config.service.methods.map((method) =>
          toOperation({
            client,
            config,
            method,
          }),
        ),
      )

      return cli
    },
  }
}

function toOperation(options: {
  client: Record<string, Function>
  config: z.output<typeof optionsSchema>
  method: DescMethod
}): Operation<any, any, any> {
  if (!['server_streaming', 'unary'].includes(options.method.methodKind))
    throw new Error(
      `Method '${options.method.name}' uses unsupported kind '${options.method.methodKind}'`,
    )

  const localName = options.method.localName
  const positionals = options.config.positionals?.[localName] ?? []
  const required = createRequiredFields(options.method.input, positionals)
  const commandName = options.config.rename?.[localName] ?? toKebab(localName)
  const input = createInputSchema(options.method.input, required)
  const args = createArgsSchema(options.method.input, positionals)
  const output = createOutputSchema(options.method.output)
  const commandOptions = createOptionsSchema(options.method.input, new Set(positionals), required)
  const mutation = resolveMutation(options.method, options.config.mutations?.[localName])

  return {
    ...(args ? { args } : undefined),
    description: humanizeMethod(options.method.name),
    ...(mutation.destructive ? { destructive: true } : undefined),
    examples: resolveExamples(
      options.method,
      args,
      commandOptions,
      options.config.examples?.[localName],
    ),
    extensions: buildExtensions({
      method: options.method,
      protocol: options.config.transport.protocol,
      service: options.config.service.typeName,
    }),
    hint: buildHint(options.method),
    input,
    kind: options.method.methodKind,
    ...(mutation.mutates ? { mutates: true } : undefined),
    name: commandName,
    ...(commandOptions ? { options: commandOptions } : undefined),
    output,
    run: createRun({
      client: options.client,
      headers: options.config.transport.headers,
      input,
      method: options.method,
    }),
  }
}

function createRun(options: {
  client: Record<string, Function>
  headers?: Transport['headers']
  input: z.ZodObject<any>
  method: DescMethod
}) {
  if (options.method.methodKind === 'server_streaming')
    return (context: any) => {
      const request = toProtoInput(
        options.method.input,
        options.input.parse({ ...context.options, ...context.args }),
      )
      return (async function* () {
        try {
          const headers = options.headers ? await options.headers() : undefined
          const fn = options.client[options.method.localName]
          if (!fn) throw new Error(`Missing generated client method '${options.method.localName}'`)
          for await (const message of fn(request, { headers }))
            yield toPlainMessage(options.method.output, message)
        } catch (error) {
          return context.error(mapRpcError(error))
        }
      })()
    }

  return async (context: any) => {
    try {
      const request = toProtoInput(
        options.method.input,
        options.input.parse({ ...context.options, ...context.args }),
      )
      const headers = options.headers ? await options.headers() : undefined
      const fn = options.client[options.method.localName]
      if (!fn) throw new Error(`Missing generated client method '${options.method.localName}'`)
      const response = await fn(request, { headers })
      return toPlainMessage(options.method.output, response)
    } catch (error) {
      return context.error(mapRpcError(error))
    }
  }
}
