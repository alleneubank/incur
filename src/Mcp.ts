import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

import { getEffectiveOptionsSchema } from './CommandOptions.js'
import { IncurError } from './Errors.js'
import * as Command from './internal/command.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Sanitize from './Sanitize.js'
import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options = {},
): Promise<void> {
  const server = new McpServer({ name, version })

  for (const tool of collectTools(commands, [])) {
    const optionsSchema = getEffectiveOptionsSchema(tool.command)
    const mergedShape: Record<string, any> = {
      ...tool.command.args?.shape,
      ...optionsSchema?.shape,
    }
    const hasInput = Object.keys(mergedShape).length > 0

    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : undefined),
        ...(hasInput ? { inputSchema: z.object(mergedShape) } : undefined),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
      } as never,
      async (...callArgs: any[]) => {
        // registerTool passes (args, extra) when inputSchema is set, (extra) when not
        const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
        const extra = hasInput ? callArgs[1] : callArgs[0]
        return callTool(tool, params, {
          extra,
          sendNotification: (n) => server.server.notification(n),
          name,
          version,
          middlewares: options.middlewares,
          env: options.env,
          vars: options.vars,
          sanitize: options.sanitize,
        })
      },
    )
  }

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const transport = new StdioServerTransport(input as any, output as any)
  await server.connect(transport)
}

export declare namespace serve {
  /** Options for the MCP server. */
  type Options = {
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Override input stream. Defaults to `process.stdin`. */
    input?: Readable | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
    /** Override output stream. Defaults to `process.stdout`. */
    output?: Writable | undefined
    /** Sanitizes tool output before it is returned to the agent. */
    sanitize?: SanitizeCallback | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    /** CLI version string. */
    version?: string | undefined
  }
}

/** Sanitize callback signature used by both `serve` and `callTool`. */
export type SanitizeCallback = (
  output: unknown,
  context: { command: string; agent: boolean },
) => Promise<{
  output: unknown
  blocked: boolean
  warnings?: string[] | undefined
}>

/** @internal Executes a tool call and returns a CallToolResult. */
export async function callTool(
  tool: ToolEntry,
  params: Record<string, unknown>,
  options: {
    extra?: {
      mcpReq?: { _meta?: { progressToken?: string | number } }
    }
    sendNotification?: (n: ProgressNotification) => Promise<void>
    name?: string | undefined
    version?: string | undefined
    middlewares?: MiddlewareHandler[] | undefined
    env?: z.ZodObject<any> | undefined
    vars?: z.ZodObject<any> | undefined
    sanitize?: SanitizeCallback | undefined
  } = {},
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}> {
  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...((tool.middlewares as MiddlewareHandler[] | undefined) ?? []),
    ...((tool.command.middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  const result = await Command.execute(tool.command, {
    agent: true,
    argv: [],
    env: options.env,
    format: 'json',
    formatExplicit: true,
    inputOptions: params,
    middlewares: allMiddleware,
    name: options.name ?? tool.name,
    parseMode: 'flat',
    path: tool.name,
    vars: options.vars,
    version: options.version,
  })

  if ('stream' in result) {
    // Streaming: send progress notifications per chunk, then return buffered result
    const chunks: unknown[] = []
    const progressToken = options.extra?.mcpReq?._meta?.progressToken
    let i = 0
    try {
      for await (const chunk of result.stream) {
        chunks.push(chunk)
        if (progressToken !== undefined && options.sendNotification)
          await options.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress: ++i, message: JSON.stringify(chunk) },
          })
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
    return renderToolResult(chunks, tool.name, options.sanitize)
  }

  if (!result.ok)
    return {
      content: [{ type: 'text', text: result.error.message ?? 'Command failed' }],
      isError: true,
    }

  const data = result.data ?? null
  const rendered = await renderToolResult(data, tool.name, options.sanitize)
  return {
    ...rendered,
    ...(data !== null && tool.outputSchema
      ? { structuredContent: data as Record<string, unknown> }
      : undefined),
  }
}

/** @internal A progress notification sent during streaming tool calls. */
type ProgressNotification = {
  method: 'notifications/progress'
  params: { progressToken: string | number; progress: number; message: string }
}

/** @internal A resolved tool entry from the command tree. */
export type ToolEntry = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  outputSchema?: Record<string, unknown> | undefined
  command: any
  middlewares?: MiddlewareHandler[] | undefined
}

/** @internal Recursively collects leaf commands as tool entries. */
export function collectTools(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[] = [],
): ToolEntry[] {
  const seen = new Map<string, string>()
  const result: ToolEntry[] = []
  collect(commands, prefix, parentMiddlewares, seen, result)
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

function collect(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[],
  seen: Map<string, string>,
  result: ToolEntry[],
) {
  for (const [name, entry] of commands) {
    if ('_alias' in entry) continue
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      const groupMw = [
        ...parentMiddlewares,
        ...((entry.middlewares as MiddlewareHandler[] | undefined) ?? []),
      ]
      collect(entry.commands, path, groupMw, seen, result)
      continue
    }

    const toolName = path.map((segment) => segment.replaceAll('-', '_')).join('_')
    const commandPath = path.join(' ')
    const existing = seen.get(toolName)
    if (existing && existing !== commandPath)
      throw new IncurError({
        code: 'MCP_TOOL_NAME_COLLISION',
        message: `MCP tool name collision for '${toolName}': '${existing}' and '${commandPath}'`,
      })

    seen.set(toolName, commandPath)
    const optionsSchema = getEffectiveOptionsSchema(entry)
    result.push({
      name: toolName,
      description: formatDescription(entry),
      inputSchema: buildToolSchema(entry.args, optionsSchema),
      ...(entry.output
        ? { outputSchema: Schema.toJsonSchema(entry.output) as Record<string, unknown> }
        : undefined),
      command: entry,
      ...(parentMiddlewares.length > 0 ? { middlewares: parentMiddlewares } : undefined),
    })
  }
}

/** @internal Builds a merged JSON Schema from args and options Zod schemas. */
function buildToolSchema(
  args: any | undefined,
  options: any | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const schema of [args, options]) {
    if (!schema) continue
    const json = Schema.toJsonSchema(schema)
    Object.assign(properties, (json.properties as Record<string, unknown>) ?? {})
    required.push(...((json.required as string[]) ?? []))
  }

  if (required.length > 0) return { type: 'object', properties, required }
  return { type: 'object', properties }
}

function formatDescription(command: any): string | undefined {
  if (!command.description)
    return command.destructive ? 'confirm with user before executing' : undefined
  if (command.destructive) return `${command.description}. confirm with user before executing`
  return command.description
}

async function renderToolResult(
  value: unknown,
  command: string,
  sanitize: SanitizeCallback | undefined,
) {
  const result = await Sanitize.sanitize(value, { command, agent: true }, sanitize)
  if (result.blocked) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            code: 'SANITIZED_OUTPUT_BLOCKED',
            message: 'Command output was blocked by sanitization',
            ...(result.warnings ? { warnings: result.warnings } : undefined),
          }),
        },
      ],
      isError: true,
    }
  }

  const payload =
    result.warnings && result.warnings.length > 0 && value && typeof result.output === 'object'
      ? { ...(result.output as Record<string, unknown>), _warnings: result.warnings }
      : result.output
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}
