import type { DescEnum, DescField, DescMessage } from '@bufbuild/protobuf'
import { ScalarType } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'

import { enumLiteral, enumName, toSnake } from './Metadata.js'

/**
 * Maps a plain JSON-like object into protobuf runtime input values.
 */
export function toProtoInput(message: DescMessage, value: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const field of message.fields) {
    const current = value[field.localName]
    if (current === undefined) continue
    result[field.localName] = toProtoField(field, current)
  }
  return result
}

/**
 * Maps a protobuf runtime message into plain JSON-like output values.
 */
export function toPlainMessage(message: DescMessage, value: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const field of message.fields) {
    const current = value[field.localName]
    if (current === undefined) continue
    result[field.localName] = toPlainField(field, current)
  }
  return result
}

/**
 * Maps Connect transport errors into stable incur error envelopes.
 */
export function mapRpcError(error: unknown) {
  const connectError = ConnectError.from(error)
  const codeName = Code[connectError.code] ?? 'Unknown'
  return {
    code: `RPC_${toSnake(codeName)}`,
    message: connectError.rawMessage,
    retryable: [
      Code.Aborted,
      Code.DeadlineExceeded,
      Code.ResourceExhausted,
      Code.Unavailable,
    ].includes(connectError.code),
  }
}

function toProtoField(field: DescField, value: unknown): unknown {
  switch (field.fieldKind) {
    case 'enum':
      return enumNumber(field.enum, value)
    case 'list':
      return Array.isArray(value) ? value.map((item) => toProtoListValue(field, item)) : []
    case 'map':
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          toProtoMapValue(field, item),
        ]),
      )
    case 'message':
      return toProtoInput(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toProtoScalar(field.scalar, value)
  }
}

function toProtoListValue(
  field: Extract<DescField, { fieldKind: 'list' }>,
  value: unknown,
): unknown {
  switch (field.listKind) {
    case 'enum':
      return enumNumber(field.enum, value)
    case 'message':
      return toProtoInput(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toProtoScalar(field.scalar, value)
  }
}

function toProtoMapValue(field: Extract<DescField, { fieldKind: 'map' }>, value: unknown): unknown {
  switch (field.mapKind) {
    case 'enum':
      return enumNumber(field.enum, value)
    case 'message':
      return toProtoInput(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toProtoScalar(field.scalar, value)
  }
}

function toProtoScalar(type: ScalarType, value: unknown): unknown {
  switch (type) {
    case ScalarType.BYTES:
      if (value instanceof Uint8Array) return value
      return Uint8Array.from(Buffer.from(String(value), 'base64'))
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if (typeof value === 'bigint') return value
      return BigInt(String(value))
    default:
      return value
  }
}

function toPlainField(field: DescField, value: unknown): unknown {
  switch (field.fieldKind) {
    case 'enum':
      return enumName(field.enum, value as number)
    case 'list':
      return Array.isArray(value) ? value.map((item) => toPlainListValue(field, item)) : []
    case 'map':
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          toPlainMapValue(field, item),
        ]),
      )
    case 'message':
      return toPlainMessage(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toPlainScalar(field.scalar, value)
  }
}

function toPlainListValue(
  field: Extract<DescField, { fieldKind: 'list' }>,
  value: unknown,
): unknown {
  switch (field.listKind) {
    case 'enum':
      return enumName(field.enum, value as number)
    case 'message':
      return toPlainMessage(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toPlainScalar(field.scalar, value)
  }
}

function toPlainMapValue(field: Extract<DescField, { fieldKind: 'map' }>, value: unknown): unknown {
  switch (field.mapKind) {
    case 'enum':
      return enumName(field.enum, value as number)
    case 'message':
      return toPlainMessage(field.message, value as Record<string, unknown>)
    case 'scalar':
      return toPlainScalar(field.scalar, value)
  }
}

function toPlainScalar(type: ScalarType, value: unknown): unknown {
  switch (type) {
    case ScalarType.BYTES:
      if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
      return Buffer.from(String(value)).toString('base64')
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return String(value)
    default:
      return value
  }
}

function enumNumber(desc: DescEnum, value: unknown) {
  if (typeof value === 'number') return value
  const match = desc.values.find((item) => enumLiteral(desc, item.name) === value)
  return match?.number ?? 0
}
