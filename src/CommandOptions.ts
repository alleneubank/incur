import { z } from 'zod'

import { ValidationError } from './Errors.js'

type CommandOptionsSource = {
  /**
   * Request body schema. Most callers use an object schema (the fields
   * get flattened into individual option flags), but OpenAPI endpoints
   * with array or primitive request bodies declare the non-object Zod
   * type directly here. The `--json` injection and handler resolution
   * logic both branch on whether the parsed payload is plain-object.
   */
  body?: z.ZodType | undefined
  input?: z.ZodObject<any> | undefined
  mutates?: boolean | undefined
  options?: z.ZodObject<any> | undefined
  paginate?: boolean | undefined
}

/** Returns the payload schema used by the injected `json` control option, if any. */
export function getPayloadSchema(command: CommandOptionsSource) {
  return command.input ?? command.body
}

/** Returns the framework-injected options schema for a command. */
export function getInjectedOptionsSchema(command: CommandOptionsSource) {
  const shape: Record<string, z.ZodType> = {}

  if (command.mutates)
    shape.dryRun = z.coerce
      .boolean()
      .default(false)
      .describe('Validate inputs and print the resolved command context without executing')

  if (getPayloadSchema(command))
    shape.json = z
      .string()
      .optional()
      .describe('Pass the full JSON payload instead of individual body flags')

  if (command.paginate)
    shape.pageSize = z.coerce.number().optional().describe('Page size to request when paginating')

  if (Object.keys(shape).length === 0) return undefined
  return z.object(shape)
}

/** Returns the effective options schema, including injected framework flags. */
export function getEffectiveOptionsSchema(command: CommandOptionsSource) {
  const injected = getInjectedOptionsSchema(command)
  if (!command.options) return injected
  if (!injected) return command.options
  return command.options.extend(injected.shape)
}

/** Resolves injected control options and merges validated `json` payloads into handler options. */
export function resolveCommandOptions(
  command: CommandOptionsSource,
  parsed: Record<string, unknown>,
) {
  const control = {
    dryRun: command.mutates ? parsed.dryRun === true : false,
    json: typeof parsed.json === 'string' ? parsed.json : undefined,
    pageSize: typeof parsed.pageSize === 'number' ? parsed.pageSize : undefined,
  }

  const options = { ...parsed }
  if (command.mutates) delete options.dryRun
  if (getPayloadSchema(command)) delete options.json

  const payloadSchema = getPayloadSchema(command)
  if (!payloadSchema || !control.json) return { control, options }

  let payload: unknown
  try {
    payload = JSON.parse(control.json)
  } catch (error) {
    throw new ValidationError({
      message: `Invalid --json payload: ${error instanceof Error ? error.message : String(error)}`,
      fieldErrors: [
        {
          path: 'json',
          expected: 'valid-json',
          received: 'invalid-json',
          message: 'Invalid JSON payload',
        },
      ],
    })
  }

  // Non-object payloads (arrays, primitives) can't be spread into
  // `options`. Route them to `options.body` as the raw JSON string so
  // the OpenAPI handler's `--body` escape hatch picks them up, and
  // still validate against the declared schema so the user gets a
  // useful error on malformed input. The existing object-spread path
  // below keeps the ergonomic flattening for object bodies.
  const isPlainObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
  if (!isPlainObject) {
    try {
      payloadSchema.parse(payload)
    } catch (error: any) {
      const issues: any[] = error?.issues ?? error?.error?.issues ?? []
      throw new ValidationError({
        message: issues.map((issue) => issue.message).join('; ') || 'Invalid --json payload',
        fieldErrors: issues.map((issue) => ({
          path: ['json', ...(issue.path ?? [])].join('.'),
          expected: issue.expected ?? '',
          received: issue.received ?? '',
          message: issue.message ?? '',
        })),
        cause: error instanceof Error ? error : undefined,
      })
    }
    return { control, options: { ...options, body: control.json } }
  }

  let parsedPayload: Record<string, unknown>
  try {
    let validationSchema: z.ZodType = payloadSchema
    if (command.input) {
      try {
        validationSchema = command.input.partial()
      } catch {
        // .partial() fails on schemas with refinements — use payloadSchema as-is
      }
    }
    parsedPayload = validationSchema.parse(payload) as Record<string, unknown>
  } catch (error: any) {
    const issues: any[] = error?.issues ?? error?.error?.issues ?? []
    throw new ValidationError({
      message: issues.map((issue) => issue.message).join('; ') || 'Invalid --json payload',
      fieldErrors: issues.map((issue) => ({
        path: ['json', ...(issue.path ?? [])].join('.'),
        expected: issue.expected ?? '',
        received: issue.received ?? '',
        message: issue.message ?? '',
      })),
      cause: error instanceof Error ? error : undefined,
    })
  }

  return { control, options: { ...options, ...parsedPayload } }
}
