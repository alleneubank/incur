import { graphql, buildSchema, introspectionFromSchema } from 'graphql'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const sdl = /* GraphQL */ `
  enum UserStatus {
    ACTIVE
    DISABLED
  }

  type User {
    id: ID!
    email: String!
    status: UserStatus!
    manager: User
  }

  type UserConnection {
    items: [User!]!
    nextCursor: String
  }

  input UpdateUserInput {
    userId: ID!
    email: String
    status: UserStatus
  }

  type DeleteUserPayload {
    deleted: Boolean!
    userId: ID!
  }

  type Query {
    getUser(userId: ID!): User!
    listUsers(status: UserStatus, limit: Int): UserConnection!
  }

  type Mutation {
    deleteUser(userId: ID!, reason: String): DeleteUserPayload!
    updateUser(input: UpdateUserInput!): User!
  }
`

/**
 * GraphQL schema used by the GraphQL plugin test fixture.
 */
export const schema = buildSchema(sdl)

/**
 * Introspection artifact derived from the GraphQL test schema.
 */
export const introspection = introspectionFromSchema(schema)

function makeUser(
  userId: string,
  status = 'ACTIVE',
  email = `${userId}@acme.dev`,
  depth = 0,
): Record<string, unknown> {
  return {
    email,
    id: userId,
    manager:
      depth >= 2
        ? null
        : makeUser(
            `${userId}-mgr-${depth + 1}`,
            status,
            `${userId}-mgr-${depth + 1}@acme.dev`,
            depth + 1,
          ),
    status,
  }
}

const rootValue = {
  deleteUser({ userId }: { reason?: string | undefined; userId: string }) {
    if (userId === 'missing') throw new Error('user was not found')
    return {
      deleted: true,
      userId,
    }
  },
  getUser({ userId }: { userId: string }) {
    if (userId === 'missing') throw new Error('user was not found')
    return makeUser(userId)
  },
  listUsers({ limit, status }: { limit?: number | undefined; status?: string | undefined }) {
    const items = ['u-1', 'u-2', 'u-3']
      .slice(0, limit ?? 2)
      .map((userId) => makeUser(userId, status ?? 'ACTIVE'))
    return {
      items,
      nextCursor: `cursor-${limit ?? 2}`,
    }
  },
  updateUser({
    input,
  }: {
    input: { email?: string | undefined; status?: string | undefined; userId: string }
  }) {
    return makeUser(
      input.userId,
      input.status ?? 'ACTIVE',
      input.email ?? `${input.userId}@acme.dev`,
    )
  },
}

/**
 * Starts a GraphQL test server.
 */
export async function startTestServer() {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/graphql') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    let body = ''
    for await (const chunk of req) body += chunk.toString()

    const payload = JSON.parse(body || '{}') as {
      operationName?: string | undefined
      query?: string | undefined
      variables?: Record<string, unknown> | undefined
    }

    const result = await graphql({
      operationName: payload.operationName,
      rootValue,
      schema,
      source: payload.query ?? '',
      variableValues: payload.variables,
    })

    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
    baseUrl: `http://127.0.0.1:${address.port}/graphql`,
  }
}
