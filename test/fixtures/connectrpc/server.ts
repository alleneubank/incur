import { ConnectError, type ConnectRouter } from '@connectrpc/connect'
import { Code } from '@connectrpc/connect'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttp2Server } from 'node:http2'
import type { AddressInfo } from 'node:net'

import { UserService, UserStatus, type GetUserResponse } from './user_pb.js'

function user(userId: string, status: UserStatus = UserStatus.USER_STATUS_ACTIVE): GetUserResponse {
  return {
    $typeName: 'acme.user.v1.GetUserResponse',
    userId,
    email: `${userId}@acme.dev`,
    status,
    tags: ['alpha', 'beta'],
  }
}

function routes(router: ConnectRouter) {
  router.service(UserService, {
    deleteUser(request) {
      if (request.userId === 'missing') throw new ConnectError('user was not found', Code.NotFound)
      return {
        deleted: true,
        userId: request.userId,
      }
    },
    getUser(request) {
      if (request.userId === 'missing') throw new ConnectError('user was not found', Code.NotFound)
      if (request.userId === 'bad')
        throw new ConnectError('user id is invalid', Code.InvalidArgument)
      if (request.userId === 'flaky')
        throw new ConnectError('backend unavailable', Code.Unavailable)
      return user(request.userId)
    },
    listUsers(request) {
      return {
        nextCursor: request.page?.cursor ? `${request.page.cursor}-next` : 'cursor-2',
        users: [
          user('u-1', request.status || UserStatus.USER_STATUS_ACTIVE),
          user('u-2', request.status || UserStatus.USER_STATUS_ACTIVE),
        ],
      }
    },
    async *watchUsers(request) {
      yield {
        eventType: request.status === UserStatus.USER_STATUS_DISABLED ? 2 : 1,
        user: user('u-1', request.status || UserStatus.USER_STATUS_ACTIVE),
      }
      yield {
        eventType: 2,
        user: user('u-2', request.status || UserStatus.USER_STATUS_ACTIVE),
      }
    },
  })
}

/**
 * Starts a Connect-compatible test server.
 */
export async function startTestServer(protocol: 'connect' | 'grpc') {
  const handler = connectNodeAdapter({ routes })

  const server =
    protocol === 'grpc' ? createHttp2Server(handler as any) : createHttpServer(handler as any)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}
