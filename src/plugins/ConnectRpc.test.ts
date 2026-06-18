import { Cli, Plugins } from 'incur'

import { startTestServer } from '../../test/fixtures/connectrpc/server.js'
import { UserService } from '../../test/fixtures/connectrpc/user_pb.js'

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
  return { output, exitCode }
}

describe('connectRpc', () => {
  test('supports the connect protocol with generated kebab-case commands', async () => {
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
            deleteUser: ['userId'],
            getUser: ['userId'],
          },
        }),
      )

      const help = await serve(cli, ['users', '--help'])
      expect(help.output).toContain('get-user')
      expect(help.output).toContain('list-users')
      expect(help.output).toContain('watch-users')

      const result = await serve(cli, ['users', 'get-user', 'u-1', '--format', 'json'])
      expect(JSON.parse(result.output)).toMatchObject({
        email: 'u-1@acme.dev',
        status: 'active',
        tags: ['alpha', 'beta'],
        userId: 'u-1',
      })
    } finally {
      await server.close()
    }
  })

  test('supports the grpc protocol with the same generated handlers', async () => {
    const server = await startTestServer('grpc')
    try {
      const cli = Cli.create('acme').plugin(
        'users',
        Plugins.connectRpc({
          service: UserService,
          transport: {
            baseUrl: server.baseUrl,
            protocol: 'grpc',
          },
          positionals: {
            getUser: ['userId'],
          },
        }),
      )

      const result = await serve(cli, ['users', 'get-user', 'u-2', '--format', 'json'])
      expect(JSON.parse(result.output)).toMatchObject({
        email: 'u-2@acme.dev',
        userId: 'u-2',
      })
    } finally {
      await server.close()
    }
  })

  test('carries explicit mutation metadata into generated manifests', async () => {
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
            deleteUser: ['userId'],
          },
          mutations: {
            deleteUser: {
              destructive: true,
              mutates: true,
            },
          },
        }),
      )

      const manifest = await serve(cli, ['users', '--llms-full', '--format', 'json'])
      expect(
        JSON.parse(manifest.output).commands.find((c: any) => c.name === 'users delete-user'),
      ).toMatchObject({
        destructive: true,
        mutates: true,
        schema: {
          options: {
            properties: {
              dryRun: { default: false, type: 'boolean' },
            },
          },
        },
      })
    } finally {
      await server.close()
    }
  })

  test('fails fast when renamed methods collide on the same command name', async () => {
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
          rename: {
            getUser: 'user',
            listUsers: 'user',
          },
        }),
      )

      const result = await serve(cli, ['users', '--help', '--format', 'json'])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.output)).toMatchObject({
        code: 'PLUGIN_RESOLUTION_FAILED',
      })
      expect(result.output).toContain("Duplicate generated command name 'user'")
    } finally {
      await server.close()
    }
  })
})
