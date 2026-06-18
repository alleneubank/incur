import { Cli, Mcp, Plugins } from 'incur'

import { startTestServer } from '../../test/fixtures/connectrpc/server.js'
import { UserService } from '../../test/fixtures/connectrpc/user_pb.js'
import {
  introspection as graphqlIntrospection,
  startTestServer as startGraphqlTestServer,
} from '../../test/fixtures/graphql/server.js'
import { toCommands } from '../Cli.js'

type Subject = {
  cli: Cli.Cli
  close?: (() => Promise<void>) | undefined
}

type Contract = {
  assertLlmsFull(command: any): void
  assertSchema(schema: any): void
  create(): Promise<Subject>
  createBroken(): Promise<Subject>
  expectedCommands: string[]
  expectedMcpTools: string[]
  fullCommandName: string
  name: string
  schemaPath: string[]
}

async function serve(
  cli: { serve: Cli.Cli['serve'] },
  argv: string[],
  options: Cli.serve.Options = {},
) {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    stderr(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
    ...options,
  })
  return { exitCode, output }
}

async function resolveCommands(cli: Cli.Cli) {
  await cli.serve(['--llms', '--format', 'json'], {
    exit() {},
    stdout() {},
    stderr() {},
  })
  return toCommands.get(cli)!
}

function contract(testContract: Contract) {
  describe(testContract.name, () => {
    test('mounted command names are stable via --llms', async () => {
      const subject = await testContract.create()
      try {
        const manifest = await serve(subject.cli, ['--llms', '--format', 'json'])
        expect(JSON.parse(manifest.output).commands.map((command: any) => command.name)).toEqual(
          testContract.expectedCommands,
        )
      } finally {
        await subject.close?.()
      }
    })

    test('mounted commands expose schema details', async () => {
      const subject = await testContract.create()
      try {
        const result = await serve(subject.cli, [
          'schema',
          ...testContract.schemaPath,
          '--format',
          'json',
        ])
        testContract.assertSchema(JSON.parse(result.output))
      } finally {
        await subject.close?.()
      }
    })

    test('mounted commands expose full llms metadata', async () => {
      const subject = await testContract.create()
      try {
        const manifest = await serve(subject.cli, ['--llms-full', '--format', 'json'])
        const command = JSON.parse(manifest.output).commands.find(
          (entry: any) => entry.name === testContract.fullCommandName,
        )
        testContract.assertLlmsFull(command)
      } finally {
        await subject.close?.()
      }
    })

    test('mounted commands project to MCP tool names', async () => {
      const subject = await testContract.create()
      try {
        const names = Mcp.collectTools(await resolveCommands(subject.cli), []).map(
          (tool) => tool.name,
        )
        expect(names).toEqual(expect.arrayContaining(testContract.expectedMcpTools))
      } finally {
        await subject.close?.()
      }
    })

    test('startup failures surface as structured plugin errors', async () => {
      const subject = await testContract.createBroken()
      try {
        const result = await serve(subject.cli, ['--help', '--format', 'json'])
        expect(result.exitCode).toBe(1)
        expect(JSON.parse(result.output)).toMatchObject({
          code: 'PLUGIN_RESOLUTION_FAILED',
        })
      } finally {
        await subject.close?.()
      }
    })
  })
}

contract({
  assertLlmsFull(command) {
    expect(command).toMatchObject({
      destructive: true,
      mutates: true,
      name: 'users delete-user',
      schema: {
        args: {
          properties: {
            userId: { type: 'string' },
          },
        },
        options: {
          properties: {
            dryRun: { default: false, type: 'boolean' },
            reason: { type: 'string' },
          },
        },
      },
    })
  },
  assertSchema(schema) {
    expect(schema).toMatchObject({
      name: 'users list-users',
      schema: {
        input: {
          properties: {
            page: { type: 'object' },
            status: {
              enum: ['active', 'disabled'],
            },
          },
        },
        options: {
          properties: {
            json: { type: 'string' },
            status: { enum: ['active', 'disabled'] },
            tags: {
              items: { type: 'string' },
              type: 'array',
            },
          },
        },
      },
    })
  },
  async create() {
    const server = await startTestServer('connect')
    return {
      cli: Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: UserService,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'connect',
          },
          positionals: {
            deleteUser: ['userId'],
            getUser: ['userId'],
          },
          mutations: {
            deleteUser: {
              destructive: true,
              mutates: true,
            },
          },
        }),
      ),
      close: server.close,
    }
  },
  async createBroken() {
    const server = await startTestServer('connect')
    return {
      cli: Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: {
            methods: [
              {
                input: UserService.methods[0]!.input,
                localName: 'syncUsers',
                methodKind: 'client_streaming',
                name: 'SyncUsers',
                output: UserService.methods[0]!.output,
              },
            ],
            typeName: 'acme.user.v1.BrokenService',
          } as any,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'connect',
          },
        }),
      ),
      close: server.close,
    }
  },
  expectedCommands: [
    'users delete-user',
    'users get-user',
    'users list-users',
    'users watch-users',
  ],
  expectedMcpTools: [
    'users_delete_user',
    'users_get_user',
    'users_list_users',
    'users_watch_users',
  ],
  fullCommandName: 'users delete-user',
  name: 'shared generated plugin contract',
  schemaPath: ['users', 'list-users'],
})

contract({
  assertLlmsFull(command) {
    expect(command).toMatchObject({
      mutates: true,
      name: 'graphql update-user',
      schema: {
        input: {
          properties: {
            input: {
              properties: {
                userId: { type: 'string' },
              },
            },
          },
        },
      },
    })
  },
  assertSchema(schema) {
    expect(schema).toMatchObject({
      name: 'graphql get-user',
      schema: {
        input: {
          properties: {
            userId: { type: 'string' },
          },
          required: ['userId'],
        },
      },
    })
  },
  async create() {
    const server = await startGraphqlTestServer()
    return {
      cli: Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: graphqlIntrospection,
          transport: {
            url: server.baseUrl,
          },
        }),
      ),
      close: server.close,
    }
  },
  async createBroken() {
    const server = await startGraphqlTestServer()
    return {
      cli: Cli.create('acme').plugin(
        'graphql',
        Plugins.graphql({
          schema: 'type Query {',
          transport: {
            url: server.baseUrl,
          },
        }),
      ),
      close: server.close,
    }
  },
  expectedCommands: [
    'graphql delete-user',
    'graphql get-user',
    'graphql list-users',
    'graphql raw',
    'graphql update-user',
  ],
  expectedMcpTools: [
    'graphql_delete_user',
    'graphql_get_user',
    'graphql_list_users',
    'graphql_raw',
    'graphql_update_user',
  ],
  fullCommandName: 'graphql update-user',
  name: 'shared graphql plugin contract',
  schemaPath: ['graphql', 'get-user'],
})
