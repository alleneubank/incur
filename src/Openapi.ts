import type {
  Document,
  OperationObject,
  ParameterObject,
  PathItemObject,
} from '@scalar/openapi-types/3.2'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as Fetch from './Fetch.js'
import { dereference } from './internal/dereference.js'
import * as Schema from './Schema.js'

/** A minimal OpenAPI 3.x spec shape. Accepts both hand-written specs and generated ones (e.g. from `@hono/zod-openapi`). */
export type OpenAPISpec = {
  components?:
    | {
        securitySchemes?: Record<string, SecurityScheme> | undefined
      }
    | undefined
  info?: Record<string, unknown> | undefined
  openapi?: string | undefined
  paths?: {} | undefined
  security?: readonly SecurityRequirement[] | undefined
}

/** OpenAPI document source accepted by fetch-backed CLI commands. */
export type OpenAPISource = OpenAPISpec | string | URL

/** Strategy used to name commands generated from OpenAPI operations. */
export type Mode = 'namespace' | 'operation'

/** Configuration for generating commands from an OpenAPI document. */
export type Config = {
  /** Command naming strategy. Defaults to `'operation'`. */
  mode?: Mode | undefined
}

/** Options for generating an OpenAPI document from an incur CLI. */
export type GenerateOptions = {
  /** API description. Defaults to the CLI description. */
  description?: string | undefined
  /** Server URLs to advertise in the generated document. */
  servers?: { url: string; description?: string | undefined }[] | undefined
  /** API title. Defaults to the CLI name. */
  title?: string | undefined
  /** API version. Defaults to `0.0.0`. */
  version?: string | undefined
}

/** HTTP methods generated for commands. */
type HttpMethod = 'delete' | 'get' | 'patch' | 'post'

/** Generates an OpenAPI 3.2 document from an incur CLI's command tree. */
export function fromCli(cli: Cli.Cli, options: GenerateOptions = {}): Document {
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const paths: NonNullable<Document['paths']> = {}
  const root = Cli.toRootDefinition.get(cli as unknown as Cli.Root)
  if (root) addCommand(paths, [], root)
  for (const [name, entry] of commands) addEntry(paths, splitCommandName(name), entry)

  return {
    openapi: '3.2.0',
    info: {
      title: options.title ?? cli.name,
      version: options.version ?? '0.0.0',
      ...((options.description ?? cli.description)
        ? { description: options.description ?? cli.description }
        : undefined),
    },
    ...(options.servers ? { servers: options.servers } : undefined),
    paths,
  }
}

/** Internal operation shape after casting. */
type Operation = {
  description?: string | undefined
  operationId?: string | undefined
  parameters?: readonly Parameter[] | undefined
  requestBody?: RequestBody | undefined
  responses?: Record<string, unknown> | undefined
  security?: readonly SecurityRequirement[] | undefined
  summary?: string | undefined
}

type Parameter = {
  description?: string | undefined
  in: 'body' | 'cookie' | 'header' | 'path' | 'query'
  name: string
  required?: boolean | undefined
  schema?: Record<string, unknown> | undefined
}

type RequestBody = {
  content?: Record<string, { schema?: Record<string, unknown> | undefined }> | undefined
  required?: boolean | undefined
}

type SecurityRequirement = Record<string, readonly string[]>

type SecurityScheme = {
  description?: string | undefined
  in?: 'cookie' | 'header' | 'query' | undefined
  name?: string | undefined
  scheme?: string | undefined
  type?: string | undefined
}

type HeaderParameter = Parameter & {
  optionName: string
}

/** A fetch handler. */
type FetchHandler = (req: Request) => Response | Promise<Response>

/** A generated command entry compatible with incur's internal CommandEntry. */
type GeneratedCommand = {
  args?: z.ZodObject<any> | undefined
  /**
   * Request body schema. Object-shaped bodies get their properties
   * flattened into `--<prop>` option flags; array and primitive bodies
   * are accepted via the injected `--json` payload or the explicit
   * `--body` JSON escape hatch. Widened from `z.ZodObject<any>` so
   * non-object schemas can participate in the `--json` injection path
   * without silent data loss.
   */
  body?: z.ZodType | undefined
  description?: string | undefined
  destructive?: boolean | undefined
  mutates?: boolean | undefined
  openapi?: Record<string, unknown> | undefined
  options?: z.ZodObject<any> | undefined
  output?: z.ZodType | undefined
  run: (context: any) => any
}

type GeneratedEntry = GeneratedCommand | GeneratedGroup

type GeneratedGroup = {
  _group: true
  description?: string | undefined
  commands: Map<string, GeneratedEntry>
}

type CommandSegment = {
  description?: string | undefined
  name: string
}

type OperationEntry = {
  method: string
  operation: Operation
  path: string
}

function addEntry(paths: NonNullable<Document['paths']>, segments: string[], entry: any) {
  if ('_alias' in entry) return
  if ('_fetch' in entry) return
  if ('_group' in entry) {
    for (const [name, child] of entry.commands)
      addEntry(paths, [...segments, ...splitCommandName(name)], child)
    return
  }
  addCommand(paths, segments, entry)
}

function splitCommandName(name: string) {
  return name.split(/\s+/).filter(Boolean)
}

function addCommand(paths: NonNullable<Document['paths']>, segments: string[], command: any) {
  const argsSchema = command.args ? Schema.toJsonSchema(command.args) : undefined
  const optionsSchema = command.options ? Schema.toJsonSchema(command.options) : undefined
  const outputSchema = command.output ? Schema.toJsonSchema(command.output) : undefined
  const args = objectProperties(argsSchema)
  const requiredArgs = new Set(requiredProperties(argsSchema))
  const method = inferMethod(segments)
  const pathVariants = createPathVariants(segments, args, requiredArgs)

  for (const variant of pathVariants) {
    const parameters: ParameterObject[] = []
    for (const name of variant.args) {
      const schema = args[name] ?? { type: 'string' }
      parameters.push({ name, in: 'path', required: true, schema })
    }
    if (method === 'get' || method === 'delete')
      for (const [name, schema] of Object.entries(objectProperties(optionsSchema)))
        parameters.push({
          name,
          in: 'query',
          ...(requiredProperties(optionsSchema).includes(name) ? { required: true } : undefined),
          schema,
        })

    const operation: OperationObject = {
      operationId: operationId(segments, method, variant.args),
      ...(command.description ? { summary: command.description } : undefined),
      ...(parameters.length ? { parameters } : undefined),
      ...requestBody(method, optionsSchema),
      responses: responses(outputSchema),
    }

    const item = (paths[variant.path] ?? {}) as PathItemObject
    ;(item as any)[method] = operation
    paths[variant.path] = item
  }
}

function createPathVariants(
  segments: string[],
  args: Record<string, Record<string, unknown>>,
  requiredArgs: Set<string>,
) {
  const names = Object.keys(args)
  const requiredCount = names.findIndex((name) => !requiredArgs.has(name))
  const baseCount = requiredCount === -1 ? names.length : requiredCount
  const variants: { args: string[]; path: `/${string}` }[] = []
  for (let count = baseCount; count <= names.length; count++) {
    const included = names.slice(0, count)
    const suffix = included.map((name) => `{${name}}`)
    variants.push({
      args: included,
      path: `/${[...segments, ...suffix].map(encodePathSegment).join('/')}`,
    })
  }
  if (variants.length === 0)
    variants.push({ args: [], path: `/${segments.map(encodePathSegment).join('/')}` })
  return variants
}

function inferMethod(segments: string[]): HttpMethod {
  const text = segments.map(splitCamelCase).join(' ').toLowerCase()
  if (/\b(delete|remove|rm|destroy|clear)\b/.test(text)) return 'delete'
  if (/\b(update|edit|modify|set|enable|disable|rename|patch)\b/.test(text)) return 'patch'
  if (/\b(get|list|show|read|search|find|status|describe|info|health|check)\b/.test(text))
    return 'get'
  return 'post'
}

function splitCamelCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

function requestBody(method: HttpMethod, schema?: Record<string, unknown> | undefined) {
  if (!schema || method === 'get' || method === 'delete') return {}
  return {
    requestBody: {
      required: requiredProperties(schema).length > 0,
      content: { 'application/json': { schema } },
    },
  }
}

function responses(schema?: Record<string, unknown> | undefined) {
  return {
    '200': {
      description: 'Command completed successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['ok', 'data', 'meta'],
            properties: {
              ok: { const: true },
              data: schema ?? {},
              meta: metaSchema(),
            },
          },
        },
      },
    },
    '400': errorResponse('Validation error.'),
    '500': errorResponse('Command failed.'),
  }
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['ok', 'error', 'meta'],
          properties: {
            ok: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retryable: { type: 'boolean' },
              },
            },
            meta: metaSchema(),
          },
        },
      },
    },
  }
}

function metaSchema() {
  return {
    type: 'object',
    required: ['command', 'duration'],
    properties: {
      command: { type: 'string' },
      duration: { type: 'string' },
    },
  }
}

function objectProperties(schema: Record<string, unknown> | undefined) {
  return (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
}

function requiredProperties(schema: Record<string, unknown> | undefined) {
  return (schema?.required ?? []) as string[]
}

function operationId(segments: string[], method: HttpMethod, args: string[]) {
  const raw = [...segments, ...(args.length ? [args.join(' ')] : [])].join(' ')
  const pascal = raw.replace(/(?:^|[\s_-]+)(\w)/g, (_, char: string) => char.toUpperCase())
  return `${method}${pascal}`
}

function encodePathSegment(segment: string) {
  if (segment.startsWith('{') && segment.endsWith('}')) return segment
  return encodeURIComponent(segment)
}

/** Resolves an OpenAPI document from a JSON object or JSON URL. */
export async function resolve(
  source: OpenAPISource,
  options: resolve.Options = {},
): Promise<OpenAPISpec> {
  if (typeof source !== 'string' && !(source instanceof URL)) return source

  const response = await fetch(resolveUrl(source, options.baseUrl))
  if (!response.ok)
    throw new Error(`Failed to fetch OpenAPI spec from ${source}: ${response.status}`)
  return (await response.json()) as OpenAPISpec
}

export declare namespace resolve {
  /** Options for resolving an OpenAPI document source. */
  type Options = {
    /** Base URL used to resolve relative OpenAPI document paths. */
    baseUrl?: string | URL | undefined
  }
}

function resolveUrl(source: string | URL, baseUrl: string | URL | undefined) {
  if (source instanceof URL) return source

  try {
    return new URL(source)
  } catch {
    if (baseUrl === undefined)
      throw new Error(`Relative OpenAPI spec URL requires a fetch URL base: ${source}`)
    const base = new URL(baseUrl)
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
    return new URL(source, base)
  }
}

/** Generates incur command entries from an OpenAPI spec. Resolves all `$ref` pointers. */
export async function generateCommands(
  spec: OpenAPISpec,
  fetch: FetchHandler,
  options: generateCommands.Options = {},
): Promise<Map<string, GeneratedEntry>> {
  const resolved = dereference(structuredClone(spec)) as OpenAPISpec
  const commands = new Map<string, GeneratedEntry>()
  const paths = (resolved.paths ?? {}) as Record<string, Record<string, unknown>>
  const operations = openapiOperations(paths)
  const namespaceInfo = getNamespaceInfo(operations)
  const { config } = options

  for (const { method, operation: op, path } of operations) {
    const segments = commandSegments({
      method,
      mode: config?.mode ?? 'operation',
      namespaceInfo,
      operation: op,
      path,
    })
    const httpMethod = method.toUpperCase()

    const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path')
    const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query')
    const headerParams = headerOptions([
      ...(op.parameters ?? []).filter((p) => p.in === 'header'),
      ...securityHeaderParams(resolved, op),
    ])
    const swagger2BodyParam = (op.parameters ?? []).find((p) => p.in === 'body')

    // OpenAPI request bodies can be any JSON type — object, array, or
    // primitive. We flatten object properties into individual `--<prop>`
    // options for ergonomics, but non-object bodies (array request bodies
    // are common for bulk endpoints) used to be silently dropped:
    // `bodySchema.properties` was undefined, `bodyKeys` was empty, and the
    // handler skipped the body entirely. We now always expose a `--body`
    // JSON escape hatch whenever a request body exists, and the handler
    // prefers it when set. Swagger 2 carries the body in an `in: body`
    // parameter rather than `requestBody`.
    const bodySchema =
      op.requestBody?.content?.['application/json']?.schema ?? swagger2BodyParam?.schema
    const bodyIsObject =
      !!bodySchema && typeof bodySchema === 'object' && (bodySchema as any).type === 'object'
    const bodyProps = bodyIsObject
      ? (((bodySchema as any).properties ?? {}) as Record<string, Record<string, unknown>>)
      : ({} as Record<string, Record<string, unknown>>)
    const bodyRequired = bodyIsObject
      ? new Set(((bodySchema as any).required as string[] | undefined) ?? [])
      : new Set<string>()
    const hasBodySchema = !!bodySchema
    // Requiredness for top-level non-object bodies (arrays, primitives).
    // OpenAPI 3 uses `requestBody.required`; Swagger 2 uses the body
    // parameter's own `required` field. Both need to be honored, otherwise
    // a Swagger 2 endpoint with `in: body, required: true, schema: { type:
    // 'array' }` would accept empty options and call the server without any
    // payload.
    const bodyRequiredTopLevel =
      op.requestBody?.required === true || swagger2BodyParam?.required === true
    const responseSchema = getResponseSchema(op.responses)

    // Build args Zod schema from path params
    let argsSchema: z.ZodObject<any> | undefined
    if (pathParams.length > 0) {
      const shape: Record<string, z.ZodType> = {}
      for (const p of pathParams) {
        let zodType = p.schema ? toZod(p.schema) : z.string()
        if (p.description) zodType = zodType.describe(p.description)
        // Path params need coercion from string argv
        shape[p.name] = coerceIfNeeded(zodType)
      }
      argsSchema = z.object(shape)
    }

    // Build options Zod schema from query params + body properties
    const optShape: Record<string, z.ZodType> = {}
    const usedOptionNames = new Set<string>()
    for (const p of queryParams) {
      let zodType = p.schema ? toZod(p.schema) : z.string()
      if (!p.required) zodType = zodType.optional()
      if (p.description) zodType = zodType.describe(p.description)
      optShape[p.name] = coerceIfNeeded(zodType)
      usedOptionNames.add(p.name)
    }
    // Flattened body properties are ALWAYS optional at schema time, even
    // when the OpenAPI spec marks them required. Parser validation runs
    // before `resolveCommandOptions`, which is where the `--json`
    // full-payload flag's fields get merged into `options` — marking a
    // per-prop flag required at schema time would reject
    // `--json '{"name":"Bob"}'` with a spurious "name is missing" error
    // because the flattened `name` option isn't populated yet. The
    // `bodyRequired` set is still passed into the handler, which enforces
    // requiredness AFTER the merge sees all three input channels (--body,
    // --json, flattened --<prop> flags).
    for (const [key, schema] of Object.entries(bodyProps)) {
      optShape[key] = toZod(schema).optional()
      usedOptionNames.add(key)
    }
    for (const p of headerParams) {
      const optionName = resolveHeaderOptionName(p.optionName, usedOptionNames)
      p.optionName = optionName
      let zodType = p.schema ? toZod(p.schema) : z.string()
      if (!p.required) zodType = zodType.optional()
      zodType = zodType.describe(p.description ?? `${p.name} header`)
      optShape[optionName] = coerceIfNeeded(zodType)
      usedOptionNames.add(optionName)
    }
    // Raw `--body` escape hatch for non-object bodies (arrays, primitives)
    // and for object bodies where the caller wants to send extra fields not
    // enumerated by the schema. Expressed as a JSON string so it round-trips
    // cleanly via argv. Always OPTIONAL in the schema even when the body is
    // required — the handler enforces requiredness after the `--json` merge.
    if (hasBodySchema) {
      optShape.body = z
        .string()
        .optional()
        .describe('Raw JSON request body. Overrides any flattened --<prop> options.')
    }
    const optionsSchema = Object.keys(optShape).length > 0 ? z.object(optShape) : undefined

    // The full request body schema (object, array, or primitive) is exposed
    // on `command.body` so the framework injects a `--json` payload option.
    // For non-object bodies, `resolveCommandOptions()` routes the parsed JSON
    // to `options.body` rather than spreading, and the handler picks it up.
    const bodyZod = bodySchema && typeof bodySchema === 'object' ? toZod(bodySchema) : undefined
    const outputSchema =
      responseSchema && typeof responseSchema === 'object' ? toZod(responseSchema) : undefined
    const operationName = op.operationId ?? `${method}_${path.replace(/[/{}]/g, '_')}`

    setCommand(commands, segments, {
      description: op.summary ?? op.description,
      args: argsSchema,
      body: bodyZod,
      destructive: httpMethod === 'DELETE',
      mutates: !['GET', 'HEAD'].includes(httpMethod),
      openapi: {
        description: op.description ?? op.summary,
        httpMethod,
        operationId: op.operationId,
        parameters: {
          ...(pathParams.length > 0
            ? {
                path: Object.fromEntries(
                  pathParams.map((param) => [param.name, param.schema ?? { type: 'string' }]),
                ),
              }
            : undefined),
          ...(queryParams.length > 0
            ? {
                query: Object.fromEntries(
                  queryParams.map((param) => [param.name, param.schema ?? { type: 'string' }]),
                ),
              }
            : undefined),
        },
        path,
        ...(bodySchema ? { requestBody: bodySchema } : undefined),
        ...(responseSchema ? { response: responseSchema } : undefined),
      },
      options: optionsSchema,
      output: outputSchema,
      run: createHandler({
        basePath: options.basePath,
        fetch,
        httpMethod,
        path,
        headerParams,
        pathParams,
        queryParams,
        bodyProps,
        bodyRequiredProps: [...bodyRequired],
        bodyRequired: bodyRequiredTopLevel,
        operationId: operationName,
      }),
    })
  }

  return commands
}

export declare namespace generateCommands {
  /** Options for generating incur commands from an OpenAPI spec. */
  type Options = {
    /** Base path prepended to generated request paths. */
    basePath?: string | undefined
    /** Configuration for generated OpenAPI commands. */
    config?: Config | undefined
  }
}

const openapiMethods = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
])

function openapiOperations(paths: Record<string, Record<string, unknown>>) {
  const operations: OperationEntry[] = []
  for (const [path, methods] of Object.entries(paths))
    for (const [method, operation] of Object.entries(methods))
      if (openapiMethods.has(method))
        operations.push({ method, operation: operation as Operation, path })
  return operations
}

function securityHeaderParams(spec: OpenAPISpec, operation: Operation): Parameter[] {
  const schemes = spec.components?.securitySchemes ?? {}
  const requirements = operation.security ?? spec.security ?? []
  const headers: Parameter[] = []

  for (const requirement of requirements)
    for (const name of Object.keys(requirement)) {
      const scheme = schemes[name]
      const parameter = securityHeaderParam(name, scheme)
      if (parameter) headers.push(parameter)
    }

  return headers
}

function securityHeaderParam(
  name: string,
  scheme: SecurityScheme | undefined,
): Parameter | undefined {
  if (!scheme) return undefined
  // `apiKey` is OpenAPI's generic name for a credential carried in a
  // header/query/cookie, not an incur- or Cadent-specific API key concept.
  if (scheme.type === 'apiKey' && scheme.in === 'header' && scheme.name)
    return {
      description: scheme.description ?? `${scheme.name} header`,
      in: 'header',
      name: scheme.name,
      required: false,
      schema: { type: 'string' },
    }

  if (scheme.type === 'http' && authorizationSchemes.has(scheme.scheme?.toLowerCase() ?? ''))
    return {
      description: scheme.description ?? `${name} authorization header`,
      in: 'header',
      name: 'authorization',
      required: false,
      schema: { type: 'string' },
    }

  return undefined
}

const authorizationSchemes = new Set(['basic', 'bearer'])

function headerOptions(parameters: Parameter[]): HeaderParameter[] {
  const seen = new Set<string>()
  const headers: HeaderParameter[] = []

  for (const parameter of parameters) {
    const normalized = parameter.name.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    headers.push({ ...parameter, optionName: normalized })
  }

  return headers
}

function resolveHeaderOptionName(optionName: string, used: Set<string>) {
  if (!used.has(optionName)) return optionName

  const prefix = `header-${optionName}`
  if (!used.has(prefix)) return prefix

  for (let index = 2; ; index++) {
    const candidate = `${prefix}-${index}`
    if (!used.has(candidate)) return candidate
  }
}

function getNamespaceInfo(operations: OperationEntry[]) {
  const pathOperations = new Map<string, number>()
  const parentPaths = new Set<string>()

  for (const { path } of operations) {
    pathOperations.set(path, (pathOperations.get(path) ?? 0) + 1)

    const segments = namespaceNames(path)
    for (let i = 1; i < segments.length; i++) parentPaths.add(`/${segments.slice(0, i).join('/')}`)
  }

  return { parentPaths, pathOperations }
}

function commandSegments(options: commandSegments.Options): CommandSegment[] {
  const { method, mode, namespaceInfo, operation, path } = options
  if (mode === 'operation')
    return [{ name: operation.operationId ?? `${method}_${path.replace(/[/{}]/g, '_')}` }]

  const segments = namespaceSegments(path, operation)
  const needsMethod =
    segments.length === 0 ||
    namespaceInfo.parentPaths.has(namespacePath(path)) ||
    (namespaceInfo.pathOperations.get(path) ?? 0) > 1
  const describedSegments = describeNamespaceLeaf(
    segments,
    operation.summary ?? operation.description,
  )
  return [
    ...(describedSegments.length > 0 ? describedSegments : [{ name: 'root' }]),
    ...(needsMethod ? [{ name: method }] : []),
  ]
}

declare namespace commandSegments {
  type Options = {
    method: string
    mode: Mode
    namespaceInfo: {
      parentPaths: Set<string>
      pathOperations: Map<string, number>
    }
    operation: Operation
    path: string
  }
}

function namespaceSegments(path: string, operation?: Operation | undefined): CommandSegment[] {
  return path
    .split('/')
    .map((segment) => namespaceSegment(segment, operation))
    .filter(isCommandSegment)
}

function namespaceNames(path: string) {
  return namespaceSegments(path).map((segment) => segment.name)
}

function namespacePath(path: string) {
  return `/${namespaceNames(path).join('/')}`
}

function namespaceSegment(
  segment: string,
  operation?: Operation | undefined,
): CommandSegment | undefined {
  if (!segment) return undefined
  const name = segment.startsWith('{') && segment.endsWith('}') ? segment.slice(1, -1) : segment
  const description = operation?.parameters?.find(
    (parameter) => parameter.in === 'path' && parameter.name === name,
  )?.description
  return {
    ...(description ? { description } : undefined),
    name: name.replace(/[^\w.-]+/g, '-'),
  }
}

function isCommandSegment(segment: CommandSegment | undefined): segment is CommandSegment {
  return segment !== undefined
}

function describeNamespaceLeaf(
  segments: CommandSegment[],
  description: string | undefined,
): CommandSegment[] {
  if (!description || segments.length === 0) return segments
  return segments.map((segment, index) =>
    index === segments.length - 1 && !segment.description ? { ...segment, description } : segment,
  )
}

function setCommand(
  commands: Map<string, GeneratedEntry>,
  segments: CommandSegment[],
  command: GeneratedCommand,
) {
  const [head, ...tail] = segments
  if (!head) return
  if (tail.length === 0) {
    commands.set(head.name, command)
    return
  }

  const group = getGroup(commands, head)
  setCommand(group.commands, tail, command)
}

function getGroup(commands: Map<string, GeneratedEntry>, segment: CommandSegment) {
  const existing = commands.get(segment.name)
  if (existing && '_group' in existing) {
    if (!existing.description && segment.description) existing.description = segment.description
    return existing
  }

  const group: GeneratedGroup = {
    _group: true,
    commands: new Map(),
    ...(segment.description ? { description: segment.description } : undefined),
  }
  commands.set(segment.name, group)
  return group
}

function createHandler(config: {
  basePath?: string | undefined
  bodyProps: Record<string, Record<string, unknown>>
  /** True when the OpenAPI spec declares the request body as required. */
  bodyRequired: boolean
  /**
   * Names of body properties that the OpenAPI spec marks as required.
   * Enforced in the handler after body assembly, because the per-prop
   * flags are kept optional at schema time so the `--json` full-payload
   * route (which merges after Parser validation) can populate them.
   */
  bodyRequiredProps: string[]
  fetch: FetchHandler
  headerParams: HeaderParameter[]
  httpMethod: string
  operationId: string
  path: string
  pathParams: Parameter[]
  queryParams: Parameter[]
}) {
  return async (context: any) => {
    const { args = {}, options = {} } = context

    // Build URL path with interpolated path params
    let urlPath = (config.basePath ?? '') + config.path
    for (const p of config.pathParams) {
      const value = args[p.name]
      if (value !== undefined) urlPath = urlPath.replace(`{${p.name}}`, String(value))
    }

    // Build query string from query params
    const query = new URLSearchParams()
    for (const p of config.queryParams) {
      const value = options[p.name]
      if (value !== undefined) query.set(p.name, String(value))
    }

    // Build request body. The raw `--body` escape hatch wins when set —
    // it's the only way to submit non-object bodies (arrays, primitives)
    // and also lets the caller include fields that were not enumerated
    // in the schema's flattened properties. Otherwise fall back to the
    // per-property convenience options.
    let body: string | undefined
    if (typeof options.body === 'string' && options.body.length > 0) {
      body = options.body
    } else {
      const bodyKeys = Object.keys(config.bodyProps)
      if (bodyKeys.length > 0) {
        const bodyObj: Record<string, unknown> = {}
        for (const key of bodyKeys) if (options[key] !== undefined) bodyObj[key] = options[key]
        if (Object.keys(bodyObj).length > 0) body = JSON.stringify(bodyObj)
      }
    }

    // Enforce requiredness AFTER merging `--body` / `--json` / flattened
    // props. The schema keeps the per-prop flags and the raw `--body`
    // flag optional at Parser time so the `--json` full-payload route
    // can populate them via `resolveCommandOptions` (which runs after
    // Parser validation). This is the single post-merge gate that
    // covers all three input channels.
    if (!body && config.bodyRequired)
      return context.error({
        code: 'VALIDATION_ERROR',
        message: `${config.operationId}: request body is required — pass --body <json> or --json <json>`,
      })

    // For object bodies with declared required properties, check that
    // the final merged body contains them. This closes the loop for
    // `--json '{"partial":"yes"}'` and friends: the handler sees the
    // full merged payload and can name the missing fields precisely.
    if (body && config.bodyRequiredProps.length > 0) {
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(body)
      } catch (err) {
        return context.error({
          code: 'VALIDATION_ERROR',
          message: `${config.operationId}: request body is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
        const record = parsedBody as Record<string, unknown>
        const missing = config.bodyRequiredProps.filter((k) => record[k] === undefined)
        if (missing.length > 0)
          return context.error({
            code: 'VALIDATION_ERROR',
            message: `${config.operationId}: missing required body fields: ${missing.join(', ')}`,
          })
      }
    }

    const input: Fetch.FetchInput = {
      path: urlPath,
      method: config.httpMethod,
      headers: new Headers(),
      body,
      query,
    }

    for (const p of config.headerParams) {
      const value = options[p.optionName]
      if (value !== undefined) input.headers.set(p.name, String(value))
    }

    if (body && !input.headers.has('content-type'))
      input.headers.set('content-type', 'application/json')

    const request = Fetch.buildRequest(input)
    const response = await config.fetch(request)
    const output = await Fetch.parseResponse(response)

    if (!output.ok)
      return context.error({
        code: `HTTP_${output.status}`,
        message:
          typeof output.data === 'object' && output.data !== null && 'message' in output.data
            ? String((output.data as any).message)
            : typeof output.data === 'string'
              ? output.data
              : `HTTP ${output.status}`,
      })

    return output.data
  }
}

function getResponseSchema(
  responses: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!responses) return undefined
  const preferred =
    Object.entries(responses).find(([status]) => /^2\d\d$/.test(status)) ??
    Object.entries(responses).find(([status]) => status === 'default')
  const response = preferred?.[1] as
    | {
        content?: Record<string, { schema?: Record<string, unknown> | undefined }> | undefined
        schema?: Record<string, unknown> | undefined
      }
    | undefined
  return response?.content?.['application/json']?.schema ?? response?.schema
}

/** Converts a JSON Schema object to a Zod schema. */
function toZod(schema: Record<string, unknown>): z.ZodType {
  return z.fromJSONSchema(schema)
}

/** Wraps a Zod schema with coercion if the base type is number or boolean (argv is always strings). */
function coerceIfNeeded(schema: z.ZodType): z.ZodType {
  const isOptional = schema instanceof z.ZodOptional
  const inner = isOptional ? schema.unwrap() : schema

  const coerced = (() => {
    // Direct number
    if (inner instanceof z.ZodNumber)
      return isOptional ? z.coerce.number().optional() : z.coerce.number()
    // Direct boolean
    if (inner instanceof z.ZodBoolean)
      return isOptional ? z.coerce.boolean().optional() : z.coerce.boolean()
    // Union containing number or boolean (e.g. type: ["number", "null"] from OpenAPI 3.1)
    if (inner instanceof z.ZodUnion) {
      const options = (inner as any)._zod?.def?.options as z.ZodType[] | undefined
      if (options?.some((o: z.ZodType) => o instanceof z.ZodNumber))
        return isOptional ? z.coerce.number().optional() : z.coerce.number()
      if (options?.some((o: z.ZodType) => o instanceof z.ZodBoolean))
        return isOptional ? z.coerce.boolean().optional() : z.coerce.boolean()
    }
    // No coercion needed
    return undefined
  })()

  if (!coerced) return schema
  const desc = (schema as any).description ?? (inner as any).description
  return desc ? coerced.describe(desc) : coerced
}
