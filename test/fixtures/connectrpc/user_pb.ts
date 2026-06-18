import type { Message } from '@bufbuild/protobuf'
import type { GenEnum, GenMessage, GenService } from '@bufbuild/protobuf/codegenv2'
import { enumDesc, fileDesc, messageDesc, serviceDesc } from '@bufbuild/protobuf/codegenv2'

/**
 * Describes the file acme/user/v1/user.proto.
 */
export const file_acme_user_v1_user = /* @__PURE__ */ fileDesc(
  'ChdhY21lL3VzZXIvdjEvdXNlci5wcm90bxIMYWNtZS51c2VyLnYxIi8KClBhZ2luYXRpb24SEQoJcGFnZV9zaXplGAEgASgNEg4KBmN1cnNvchgCIAEoCSIhCg5HZXRVc2VyUmVxdWVzdBIPCgd1c2VyX2lkGAEgASgJImkKD0dldFVzZXJSZXNwb25zZRIPCgd1c2VyX2lkGAEgASgJEg0KBWVtYWlsGAIgASgJEigKBnN0YXR1cxgDIAEoDjIYLmFjbWUudXNlci52MS5Vc2VyU3RhdHVzEgwKBHRhZ3MYBCADKAkicgoQTGlzdFVzZXJzUmVxdWVzdBIoCgZzdGF0dXMYASABKA4yGC5hY21lLnVzZXIudjEuVXNlclN0YXR1cxIMCgR0YWdzGAIgAygJEiYKBHBhZ2UYAyABKAsyGC5hY21lLnVzZXIudjEuUGFnaW5hdGlvbiJWChFMaXN0VXNlcnNSZXNwb25zZRIsCgV1c2VycxgBIAMoCzIdLmFjbWUudXNlci52MS5HZXRVc2VyUmVzcG9uc2USEwoLbmV4dF9jdXJzb3IYAiABKAkiPQoRV2F0Y2hVc2Vyc1JlcXVlc3QSKAoGc3RhdHVzGAEgASgOMhguYWNtZS51c2VyLnYxLlVzZXJTdGF0dXMiZQoJVXNlckV2ZW50EisKCmV2ZW50X3R5cGUYASABKA4yFy5hY21lLnVzZXIudjEuRXZlbnRUeXBlEisKBHVzZXIYAiABKAsyHS5hY21lLnVzZXIudjEuR2V0VXNlclJlc3BvbnNlIjQKEURlbGV0ZVVzZXJSZXF1ZXN0Eg8KB3VzZXJfaWQYASABKAkSDgoGcmVhc29uGAIgASgJIjYKEkRlbGV0ZVVzZXJSZXNwb25zZRIPCgdkZWxldGVkGAEgASgIEg8KB3VzZXJfaWQYAiABKAkqWwoKVXNlclN0YXR1cxIbChdVU0VSX1NUQVRVU19VTlNQRUNJRklFRBAAEhYKElVTRVJfU1RBVFVTX0FDVElWRRABEhgKFFVTRVJfU1RBVFVTX0RJU0FCTEVEEAIqVwoJRXZlbnRUeXBlEhoKFkVWRU5UX1RZUEVfVU5TUEVDSUZJRUQQABIWChJFVkVOVF9UWVBFX1VQREFURUQQARIWChJFVkVOVF9UWVBFX0RFTEVURUQQAjK+AgoLVXNlclNlcnZpY2USRgoHR2V0VXNlchIcLmFjbWUudXNlci52MS5HZXRVc2VyUmVxdWVzdBodLmFjbWUudXNlci52MS5HZXRVc2VyUmVzcG9uc2USTAoJTGlzdFVzZXJzEh4uYWNtZS51c2VyLnYxLkxpc3RVc2Vyc1JlcXVlc3QaHy5hY21lLnVzZXIudjEuTGlzdFVzZXJzUmVzcG9uc2USSAoKV2F0Y2hVc2VycxIfLmFjbWUudXNlci52MS5XYXRjaFVzZXJzUmVxdWVzdBoXLmFjbWUudXNlci52MS5Vc2VyRXZlbnQwARJPCgpEZWxldGVVc2VyEh8uYWNtZS51c2VyLnYxLkRlbGV0ZVVzZXJSZXF1ZXN0GiAuYWNtZS51c2VyLnYxLkRlbGV0ZVVzZXJSZXNwb25zZWIGcHJvdG8z',
)

export enum UserStatus {
  USER_STATUS_UNSPECIFIED = 0,
  USER_STATUS_ACTIVE = 1,
  USER_STATUS_DISABLED = 2,
}

export enum EventType {
  EVENT_TYPE_UNSPECIFIED = 0,
  EVENT_TYPE_UPDATED = 1,
  EVENT_TYPE_DELETED = 2,
}

export type Pagination = Message<'acme.user.v1.Pagination'> & {
  cursor: string
  pageSize: number
}

export type GetUserRequest = Message<'acme.user.v1.GetUserRequest'> & {
  userId: string
}

export type GetUserResponse = Message<'acme.user.v1.GetUserResponse'> & {
  email: string
  status: UserStatus
  tags: string[]
  userId: string
}

export type ListUsersRequest = Message<'acme.user.v1.ListUsersRequest'> & {
  page?: Pagination
  status: UserStatus
  tags: string[]
}

export type ListUsersResponse = Message<'acme.user.v1.ListUsersResponse'> & {
  nextCursor: string
  users: GetUserResponse[]
}

export type WatchUsersRequest = Message<'acme.user.v1.WatchUsersRequest'> & {
  status: UserStatus
}

export type UserEvent = Message<'acme.user.v1.UserEvent'> & {
  eventType: EventType
  user?: GetUserResponse
}

export type DeleteUserRequest = Message<'acme.user.v1.DeleteUserRequest'> & {
  reason: string
  userId: string
}

export type DeleteUserResponse = Message<'acme.user.v1.DeleteUserResponse'> & {
  deleted: boolean
  userId: string
}

export const UserStatusSchema: GenEnum<UserStatus> = /* @__PURE__ */ enumDesc(
  file_acme_user_v1_user,
  0,
)

export const EventTypeSchema: GenEnum<EventType> = /* @__PURE__ */ enumDesc(
  file_acme_user_v1_user,
  1,
)

export const PaginationSchema: GenMessage<Pagination> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  0,
)

export const GetUserRequestSchema: GenMessage<GetUserRequest> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  1,
)

export const GetUserResponseSchema: GenMessage<GetUserResponse> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  2,
)

export const ListUsersRequestSchema: GenMessage<ListUsersRequest> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  3,
)

export const ListUsersResponseSchema: GenMessage<ListUsersResponse> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  4,
)

export const WatchUsersRequestSchema: GenMessage<WatchUsersRequest> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  5,
)

export const UserEventSchema: GenMessage<UserEvent> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  6,
)

export const DeleteUserRequestSchema: GenMessage<DeleteUserRequest> = /* @__PURE__ */ messageDesc(
  file_acme_user_v1_user,
  7,
)

export const DeleteUserResponseSchema: GenMessage<DeleteUserResponse> =
  /* @__PURE__ */ messageDesc(file_acme_user_v1_user, 8)

export const UserService: GenService<{
  deleteUser: {
    input: typeof DeleteUserRequestSchema
    methodKind: 'unary'
    output: typeof DeleteUserResponseSchema
  }
  getUser: {
    input: typeof GetUserRequestSchema
    methodKind: 'unary'
    output: typeof GetUserResponseSchema
  }
  listUsers: {
    input: typeof ListUsersRequestSchema
    methodKind: 'unary'
    output: typeof ListUsersResponseSchema
  }
  watchUsers: {
    input: typeof WatchUsersRequestSchema
    methodKind: 'server_streaming'
    output: typeof UserEventSchema
  }
}> = /* @__PURE__ */ serviceDesc(file_acme_user_v1_user, 0)
