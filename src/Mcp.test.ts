import { Cli, Mcp, Plugins, z } from 'incur'
import { PassThrough } from 'node:stream'

import { startTestServer } from '../test/fixtures/connectrpc/server.js'
import { UserService } from '../test/fixtures/connectrpc/user_pb.js'
import {
  introspection as graphqlIntrospection,
  startTestServer as startGraphqlTestServer,
} from '../test/fixtures/graphql/server.js'
import { toCommands } from './Cli.js'

function createTestCommands() {
  const commands = new Map<string, any>()

  commands.set('ping', {
    description: 'Health check',
    run() {
      return { pong: true }
    },
  })

  commands.set('echo', {
    description: 'Echo a message',
    args: z.object({
      message: z.string().describe('Message to echo'),
    }),
    options: z.object({
      upper: z.boolean().default(false).describe('Uppercase output'),
    }),
    run(c: any) {
      const msg = c.options.upper ? c.args.message.toUpperCase() : c.args.message
      return { result: msg }
    },
  })

  commands.set('greet', {
    _group: true,
    description: 'Greeting commands',
    commands: new Map([
      [
        'hello',
        {
          description: 'Say hello',
          args: z.object({ name: z.string().describe('Name to greet') }),
          run(c: any) {
            return { greeting: `hello ${c.args.name}` }
          },
        },
      ],
    ]),
  })

  commands.set('fail', {
    description: 'Always fails',
    run(c: any) {
      return c.error({ code: 'BOOM', message: 'it broke' })
    },
  })

  commands.set('stream', {
    description: 'Stream chunks',
    async *run() {
      yield { content: 'hello' }
      yield { content: 'world' }
    },
  })

  commands.set('destroy', {
    description: 'Delete everything',
    destructive: true,
    mutates: true,
    run() {
      return { ok: true }
    },
  })

  commands.set('deploy', {
    description: 'Deploy a service',
    body: z.object({
      region: z.string(),
      replicas: z.number().default(1),
    }),
    options: z.object({
      region: z.string().optional(),
      replicas: z.number().default(1),
    }),
    run(c: any) {
      return c.options
    },
  })

  const issueUpdateInput = z.object({
    id: z.string(),
    input: z.object({
      email: z.string().optional(),
    }),
  })

  commands.set('issue-update', {
    args: z.object({ id: z.string() }),
    description: 'Update an issue with a mixed scalar and input payload',
    input: issueUpdateInput,
    options: z.object({
      id: z.string().optional(),
    }),
    run(c: any) {
      return issueUpdateInput.parse({ ...c.options, ...c.args })
    },
  })

  return commands
}

/** Standard initialize params for MCP protocol. */
const initParams = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
}

/** Sends JSON-RPC messages, ends the stream, waits for serve to finish, returns parsed responses. */
async function mcpSession(
  commands: Map<string, any>,
  messages: { method: string; params?: unknown; id?: number }[],
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk) => chunks.push(chunk.toString()))

  const done = Mcp.serve('test-cli', '1.0.0', commands, { input, output })

  for (const msg of messages) {
    const rpc = { jsonrpc: '2.0', ...msg }
    input.write(`${JSON.stringify(rpc)}\n`)
  }

  // Give time for async processing then close
  await new Promise((r) => setTimeout(r, 20))
  input.end()
  await done

  return chunks.map((c) => JSON.parse(c.trim()))
}

async function resolveCommands(cli: Cli.Cli) {
  await cli.serve(['--llms', '--format', 'json'], {
    exit() {},
    stdout() {},
    stderr() {},
  })
  return toCommands.get(cli)!
}

describe('Mcp', () => {
  test('initialize responds with server info', async () => {
    const [res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
    ])
    expect(res.id).toBe(1)
    expect(res.result.protocolVersion).toBe('2024-11-05')
    expect(res.result.serverInfo).toEqual({ name: 'test-cli', version: '1.0.0' })
    expect(res.result.capabilities.tools).toBeDefined()
  })

  test('initialize with 2025-03-26 protocol version', async () => {
    const [res] = await mcpSession(createTestCommands(), [
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
    ])
    expect(res.result.serverInfo).toEqual({ name: 'test-cli', version: '1.0.0' })
    expect(res.result.capabilities.tools).toBeDefined()
  })

  test('tools/list returns all leaf commands as tools', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    const names = res.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual([
      'deploy',
      'destroy',
      'echo',
      'fail',
      'greet_hello',
      'issue_update',
      'ping',
      'stream',
    ])

    const echoTool = res.result.tools.find((t: any) => t.name === 'echo')
    expect(echoTool.description).toBe('Echo a message')
    expect(echoTool.inputSchema.properties.message).toBeDefined()
    expect(echoTool.inputSchema.properties.upper).toBeDefined()
    expect(echoTool.inputSchema.required).toContain('message')

    const destroyTool = res.result.tools.find((t: any) => t.name === 'destroy')
    expect(destroyTool.description).toContain('confirm with user before executing')
    expect(destroyTool.inputSchema.properties.dryRun).toBeDefined()
  })

  test('notifications are ignored (no response)', async () => {
    const responses = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { method: 'notifications/initialized' },
      { id: 2, method: 'ping' },
    ])
    expect(responses).toHaveLength(2)
    expect(responses[0].id).toBe(1)
    expect(responses[1].id).toBe(2)
  })

  test('tools/call executes simple command', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"pong":true}' }])
  })

  test('tools/call with args and options', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello', upper: true } },
      },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"result":"HELLO"}' }])
  })

  test('tools/call with nested group command', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'greet_hello', arguments: { name: 'world' } },
      },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"greeting":"hello world"}' }])
  })

  test('tools/call unknown tool returns error', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ])
    // SDK returns a JSON-RPC error for unknown tools
    const hasError = res.error?.message?.includes('nope') || res.result?.isError
    expect(hasError).toBeTruthy()
  })

  test('tools/call with sentinel error result', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'fail', arguments: {} } },
    ])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toBe('it broke')
  })

  test('unknown method returns JSON-RPC error', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'bogus/method', params: {} },
    ])
    // SDK returns either a JSON-RPC error or ignores unknown methods
    expect(res.error ?? res.result).toBeDefined()
  })

  test('ping returns empty object', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'ping' },
    ])
    expect(res.result).toEqual({})
  })

  test('options get defaults applied', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hi' } } },
    ])
    // upper defaults to false, so message stays lowercase
    expect(res.result.content).toEqual([{ type: 'text', text: '{"result":"hi"}' }])
  })

  test('streaming command buffers chunks into array', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'stream', arguments: {} } },
    ])
    expect(res.result.content).toEqual([
      { type: 'text', text: '[{"content":"hello"},{"content":"world"}]' },
    ])
  })

  test('tools/call resolves injected json payload through shared option parsing', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deploy',
          arguments: { json: '{"region":"us-central1","replicas":3}' },
        },
      },
    ])
    expect({
      type: res.result.content[0].type,
      data: JSON.parse(res.result.content[0].text),
    }).toEqual({
      type: 'text',
      data: { region: 'us-central1', replicas: 3 },
    })
  })

  test('tools/call merges json payload with scalar args for input commands', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'issue_update',
          arguments: { id: 'ISS-1', json: '{"input":{"email":"issue@example.com"}}' },
        },
      },
    ])
    expect({
      type: res.result.content[0].type,
      data: JSON.parse(res.result.content[0].text),
    }).toEqual({
      type: 'text',
      data: { id: 'ISS-1', input: { email: 'issue@example.com' } },
    })
  })

  test('middleware runs for tool calls', async () => {
    const commands = new Map<string, any>()
    commands.set('secret', {
      description: 'Protected command',
      run: () => ({ secret: 'data' }),
    })
    const middlewares = [
      async (_c: any, next: () => Promise<void>) => {
        _c.set('ran', true)
        await next()
      },
    ]
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', commands, {
      input,
      output,
      middlewares,
      vars: z.object({ ran: z.boolean().default(false) }),
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 10))
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'secret', arguments: {} } })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const responses = chunks.map((c) => JSON.parse(c.trim()))
    const callRes = responses.find((r: any) => r.id === 2)
    expect(callRes.result.content).toEqual([{ type: 'text', text: '{"secret":"data"}' }])
  })

  test('middleware error blocks tool call', async () => {
    const commands = new Map<string, any>()
    commands.set('secret', {
      description: 'Protected',
      run: () => ({ secret: true }),
    })
    const middlewares = [
      (c: any) => {
        c.error({ code: 'FORBIDDEN', message: 'not allowed' })
      },
    ]
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', commands, {
      input,
      output,
      middlewares,
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 10))
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'secret', arguments: {} } })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const responses = chunks.map((c) => JSON.parse(c.trim()))
    const callRes = responses.find((r: any) => r.id === 2)
    expect(callRes.result.isError).toBe(true)
    expect(callRes.result.content[0].text).toBe('not allowed')
  })

  test('group middleware runs for nested tool calls', async () => {
    const commands = new Map<string, any>()
    const groupMiddleware = async (c: any, next: () => Promise<void>) => {
      c.set('group', 'admin')
      await next()
    }
    commands.set('admin', {
      _group: true,
      description: 'Admin commands',
      middlewares: [groupMiddleware],
      commands: new Map([
        [
          'status',
          {
            description: 'Admin status',
            run: (c: any) => ({ group: c.var.group }),
          },
        ],
      ]),
    })

    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', commands, {
      input,
      output,
      vars: z.object({ group: z.string().default('none') }),
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 10))
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'admin_status', arguments: {} } })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const responses = chunks.map((c) => JSON.parse(c.trim()))
    const callRes = responses.find((r: any) => r.id === 2)
    expect(callRes.result.content).toEqual([{ type: 'text', text: '{"group":"admin"}' }])
  })

  test('env schema is parsed for tool calls', async () => {
    const commands = new Map<string, any>()
    commands.set('check-env', {
      description: 'Check env',
      env: z.object({ MY_VAR: z.string().default('default-val') }),
      run: (c: any) => ({ val: c.env.MY_VAR }),
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'check_env', arguments: {} } },
    ])
    const data = JSON.parse(res.result.content[0].text)
    expect(data.val).toBe('default-val')
  })

  test('streaming command sends progress notifications', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: any[] = []
    output.on('data', (chunk) => chunks.push(JSON.parse(chunk.toString().trim())))

    const done = Mcp.serve('test-cli', '1.0.0', createTestCommands(), { input, output })

    // Initialize
    input.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 10))

    // Call streaming tool with progressToken
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'stream', arguments: {}, _meta: { progressToken: 'tok-1' } },
      }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 50))
    input.end()
    await done

    // Filter for progress notifications
    const progress = chunks.filter((c) => c.method === 'notifications/progress')
    expect(progress).toHaveLength(2)
    expect(progress[0].params.message).toBe('{"content":"hello"}')
    expect(progress[1].params.message).toBe('{"content":"world"}')
    expect(progress[0].params.progress).toBe(1)
    expect(progress[1].params.progress).toBe(2)
  })

  test('plugin-generated commands project to underscore MCP tool names', async () => {
    const server = await startTestServer('connect')
    try {
      const cli = Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: UserService,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'connect',
          },
          positionals: {
            getUser: ['userId'],
          },
        }),
      )

      const commands = await resolveCommands(cli)
      const names = Mcp.collectTools(commands, []).map((tool) => tool.name)
      expect(names).toContain('users_get_user')
      expect(names).toContain('users_list_users')
      expect(names).toContain('users_watch_users')
    } finally {
      await server.close()
    }
  })

  test('CLI and MCP reuse the same generated handler behavior', async () => {
    const server = await startTestServer('connect')
    try {
      const cli = Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: UserService,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'connect',
          },
          positionals: {
            getUser: ['userId'],
          },
        }),
      )

      let cliOutput = ''
      await cli.serve(['users', 'get-user', 'u-1', '--format', 'json'], {
        stdout(s) {
          cliOutput += s
        },
        stderr(s) {
          cliOutput += s
        },
        exit() {},
      })

      const commands = await resolveCommands(cli)
      const tool = Mcp.collectTools(commands, []).find((entry) => entry.name === 'users_get_user')!
      const result = await Mcp.callTool(tool, { userId: 'u-1' })

      expect(JSON.parse(cliOutput)).toEqual(JSON.parse(result.content[0]!.text))
    } finally {
      await server.close()
    }
  })

  test('graphql-generated commands project to underscore MCP tool names', async () => {
    const server = await startGraphqlTestServer()
    try {
      const cli = Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: graphqlIntrospection,
          transport: {
            url: server.baseUrl,
          },
        }),
      )

      const commands = await resolveCommands(cli)
      const names = Mcp.collectTools(commands, []).map((tool) => tool.name)
      expect(names).toContain('graphql_get_user')
      expect(names).toContain('graphql_list_users')
      expect(names).toContain('graphql_raw')
      expect(names).toContain('graphql_update_user')
    } finally {
      await server.close()
    }
  })

  test('rejects duplicate MCP tool names after underscore projection', () => {
    const commands = new Map<string, any>([
      [
        'foo-bar',
        {
          _group: true,
          commands: new Map([
            [
              'baz',
              {
                run() {
                  return { ok: true }
                },
              },
            ],
          ]),
        },
      ],
      [
        'foo',
        {
          _group: true,
          commands: new Map([
            [
              'bar-baz',
              {
                run() {
                  return { ok: true }
                },
              },
            ],
          ]),
        },
      ],
    ])

    expect(() => Mcp.collectTools(commands, [])).toThrow(
      "MCP tool name collision for 'foo_bar_baz': 'foo-bar baz' and 'foo bar-baz'",
    )
  })
})
