import { ScalarType } from '@bufbuild/protobuf'
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt'
import { describe, expect, test, vi } from 'vitest'

const { uploadBlob } = vi.hoisted(() => ({
  uploadBlob: vi.fn(),
}))

vi.mock('@connectrpc/connect', async () => {
  const actual = await vi.importActual<typeof import('@connectrpc/connect')>('@connectrpc/connect')
  return {
    ...actual,
    createClient: vi.fn(() => ({
      uploadBlob,
    })),
  }
})

vi.mock('@connectrpc/connect-node', () => ({
  createConnectTransport: vi.fn(() => ({})),
  createGrpcTransport: vi.fn(() => ({})),
}))

import * as Cli from '../Cli.js'
import { toCommands } from '../Cli.js'
import * as Mcp from '../Mcp.js'
import { connectRpc } from './ConnectRpc.js'

type TestField = {
  [key: string]: unknown
  fieldKind: string
  localName: string
}

function scalarField(localName: string, scalar: ScalarType, extra: Record<string, unknown> = {}) {
  return {
    fieldKind: 'scalar',
    localName,
    presence: FeatureSet_FieldPresence.IMPLICIT,
    scalar,
    ...extra,
  } as const
}

function messageField(
  localName: string,
  fieldMessage: {
    field: Record<string, TestField>
    fields: TestField[]
    oneofs: readonly unknown[]
    typeName: string
  },
) {
  return {
    fieldKind: 'message',
    localName,
    message: fieldMessage,
    presence: FeatureSet_FieldPresence.EXPLICIT,
  } as const
}

function listScalarField(localName: string, scalar: ScalarType) {
  return {
    fieldKind: 'list',
    listKind: 'scalar',
    localName,
    presence: FeatureSet_FieldPresence.IMPLICIT,
    scalar,
  } as const
}

function mapScalarField(localName: string, scalar: ScalarType) {
  return {
    fieldKind: 'map',
    localName,
    mapKind: 'scalar',
    presence: FeatureSet_FieldPresence.IMPLICIT,
    scalar,
  } as const
}

function message(typeName: string, fields: TestField[]) {
  return {
    field: Object.fromEntries(fields.map((field) => [field.localName, field])),
    fields,
    oneofs: [],
    typeName,
  } as const
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
  return { output, exitCode }
}

async function resolveCommands(cli: Cli.Cli) {
  await cli.serve(['--llms', '--format', 'json'], {
    exit() {},
    stdout() {},
    stderr() {},
  })
  return toCommands.get(cli)!
}

describe('connectRpc scalar handling', () => {
  test('enforces descriptor-required fields that are not positional', async () => {
    uploadBlob.mockReset()
    uploadBlob.mockImplementation(async (request: Record<string, unknown>) => request)

    const input = message('acme.scalar.v1.UploadBlobRequest', [
      scalarField('tenantId', ScalarType.STRING, {
        presence: FeatureSet_FieldPresence.LEGACY_REQUIRED,
      }),
      scalarField('userId', ScalarType.STRING),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      scalarField('tenantId', ScalarType.STRING),
      scalarField('userId', ScalarType.STRING),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    const result = await serve(cli, [
      'scalars',
      'upload-blob',
      '--userId',
      'u-123',
      '--format',
      'json',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('tenantId')
    expect(uploadBlob).not.toHaveBeenCalled()
  })

  test('enforces descriptor-required fields nested inside message inputs', async () => {
    uploadBlob.mockReset()
    uploadBlob.mockImplementation(async (request: Record<string, unknown>) => request)

    const profile = message('acme.scalar.v1.Profile', [
      scalarField('tenantId', ScalarType.STRING, {
        presence: FeatureSet_FieldPresence.LEGACY_REQUIRED,
      }),
      scalarField('name', ScalarType.STRING),
    ])
    const input = message('acme.scalar.v1.UploadBlobRequest', [messageField('profile', profile)])
    const output = message('acme.scalar.v1.UploadBlobResponse', [messageField('profile', profile)])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    const result = await serve(cli, [
      'scalars',
      'upload-blob',
      '--json',
      JSON.stringify({ profile: { name: 'alice' } }),
      '--format',
      'json',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('tenantId')
    expect(uploadBlob).not.toHaveBeenCalled()
  })

  test('rejects invalid base64 for bytes fields', async () => {
    uploadBlob.mockReset()

    const input = message('acme.scalar.v1.UploadBlobRequest', [
      scalarField('payload', ScalarType.BYTES),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      scalarField('payload', ScalarType.BYTES),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    // Invalid characters
    const invalid = await serve(cli, [
      'scalars',
      'upload-blob',
      '--payload',
      '!!!not-base64!!!',
      '--format',
      'json',
    ])
    expect(invalid.exitCode).toBe(1)

    // Valid alphabet but wrong length (not divisible by 4)
    const wrongLen = await serve(cli, [
      'scalars',
      'upload-blob',
      '--payload',
      'abc',
      '--format',
      'json',
    ])
    expect(wrongLen.exitCode).toBe(1)

    // Single character
    const single = await serve(cli, [
      'scalars',
      'upload-blob',
      '--payload',
      'a',
      '--format',
      'json',
    ])
    expect(single.exitCode).toBe(1)

    expect(uploadBlob).not.toHaveBeenCalled()
  })

  test('rejects fractional and out-of-range 32-bit integers', async () => {
    uploadBlob.mockReset()

    const input = message('acme.scalar.v1.UploadBlobRequest', [
      scalarField('count', ScalarType.INT32),
      scalarField('size', ScalarType.UINT32),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      scalarField('count', ScalarType.INT32),
      scalarField('size', ScalarType.UINT32),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    // Fractional int32
    const fractional = await serve(cli, [
      'scalars',
      'upload-blob',
      '--count',
      '1.5',
      '--format',
      'json',
    ])
    expect(fractional.exitCode).toBe(1)

    // Negative uint32
    const negative = await serve(cli, [
      'scalars',
      'upload-blob',
      '--size',
      '-1',
      '--format',
      'json',
    ])
    expect(negative.exitCode).toBe(1)

    // Out-of-range int32
    const overflow = await serve(cli, [
      'scalars',
      'upload-blob',
      '--count',
      '2147483648',
      '--format',
      'json',
    ])
    expect(overflow.exitCode).toBe(1)

    expect(uploadBlob).not.toHaveBeenCalled()
  })

  test('accepts valid 32-bit integers', async () => {
    uploadBlob.mockReset()
    uploadBlob.mockImplementation(async (request: Record<string, unknown>) => request)

    const input = message('acme.scalar.v1.UploadBlobRequest', [
      scalarField('count', ScalarType.INT32),
      scalarField('size', ScalarType.UINT32),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      scalarField('count', ScalarType.INT32),
      scalarField('size', ScalarType.UINT32),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    const result = await serve(cli, [
      'scalars',
      'upload-blob',
      '--count',
      '-2147483648',
      '--size',
      '4294967295',
      '--format',
      'json',
    ])
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.output)).toEqual({ count: -2147483648, size: 4294967295 })
  })

  test('rejects out-of-range 64-bit integers', async () => {
    uploadBlob.mockReset()

    const input = message('acme.scalar.v1.UploadBlobRequest', [
      scalarField('signedCount', ScalarType.INT64),
      scalarField('unsignedCount', ScalarType.UINT64),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      scalarField('signedCount', ScalarType.INT64),
      scalarField('unsignedCount', ScalarType.UINT64),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    // int64 overflow (2^63)
    const signedOverflow = await serve(cli, [
      'scalars',
      'upload-blob',
      '--signedCount',
      '9223372036854775808',
      '--format',
      'json',
    ])
    expect(signedOverflow.exitCode).toBe(1)

    // uint64 overflow (2^64)
    const unsignedOverflow = await serve(cli, [
      'scalars',
      'upload-blob',
      '--unsignedCount',
      '18446744073709551616',
      '--format',
      'json',
    ])
    expect(unsignedOverflow.exitCode).toBe(1)

    // negative uint64
    const negativeUnsigned = await serve(cli, [
      'scalars',
      'upload-blob',
      '--unsignedCount',
      '-1',
      '--format',
      'json',
    ])
    expect(negativeUnsigned.exitCode).toBe(1)

    expect(uploadBlob).not.toHaveBeenCalled()
  })

  test('converts 64-bit integers and bytes losslessly for CLI, schema, and MCP', async () => {
    uploadBlob.mockReset()
    uploadBlob.mockImplementation(async (request: Record<string, unknown>) => request)

    const input = message('acme.scalar.v1.UploadBlobRequest', [
      scalarField('signedCount', ScalarType.INT64),
      scalarField('unsignedCount', ScalarType.UINT64),
      scalarField('payload', ScalarType.BYTES),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      scalarField('signedCount', ScalarType.INT64),
      scalarField('unsignedCount', ScalarType.UINT64),
      scalarField('payload', ScalarType.BYTES),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: {
          baseUrl: 'https://example.test',
          protocol: 'connect',
        },
      }),
    )

    const schema = await serve(cli, ['scalars', 'upload-blob', '--schema', '--format', 'json'])
    expect(JSON.parse(schema.output)).toMatchObject({
      options: {
        properties: {
          payload: { type: 'string' },
          signedCount: { type: 'string' },
          unsignedCount: { type: 'string' },
        },
      },
      output: {
        properties: {
          payload: { type: 'string' },
          signedCount: { type: 'string' },
          unsignedCount: { type: 'string' },
        },
      },
    })

    const cliResult = await serve(cli, [
      'scalars',
      'upload-blob',
      '--signedCount',
      '-42',
      '--unsignedCount',
      '18446744073709551615',
      '--payload',
      'AQID',
      '--format',
      'json',
    ])
    expect(JSON.parse(cliResult.output)).toEqual({
      payload: 'AQID',
      signedCount: '-42',
      unsignedCount: '18446744073709551615',
    })

    expect(uploadBlob).toHaveBeenCalledTimes(1)
    const request = uploadBlob.mock.calls[0]![0] as {
      payload: Uint8Array
      signedCount: bigint
      unsignedCount: bigint
    }
    expect(request.signedCount).toBe(-42n)
    expect(request.unsignedCount).toBe(18446744073709551615n)
    expect([...request.payload]).toEqual([1, 2, 3])

    const commands = await resolveCommands(cli)
    const tool = Mcp.collectTools(commands, []).find(
      (entry) => entry.name === 'scalars_upload_blob',
    )!
    const mcpResult = await Mcp.callTool(tool, {
      payload: 'AQID',
      signedCount: '-42',
      unsignedCount: '18446744073709551615',
    })
    expect(JSON.parse(mcpResult.content[0]!.text)).toEqual({
      payload: 'AQID',
      signedCount: '-42',
      unsignedCount: '18446744073709551615',
    })
  })

  test('roundtrips nested messages, lists, and maps through --json input', async () => {
    uploadBlob.mockReset()
    uploadBlob.mockImplementation(async (request: Record<string, unknown>) => request)

    const profile = message('acme.scalar.v1.Profile', [scalarField('name', ScalarType.STRING)])
    const input = message('acme.scalar.v1.UploadBlobRequest', [
      listScalarField('tags', ScalarType.STRING),
      mapScalarField('labels', ScalarType.STRING),
      messageField('profile', profile),
    ])
    const output = message('acme.scalar.v1.UploadBlobResponse', [
      listScalarField('tags', ScalarType.STRING),
      mapScalarField('labels', ScalarType.STRING),
      messageField('profile', profile),
    ])
    const service = {
      methods: [
        {
          input,
          localName: 'uploadBlob',
          methodKind: 'unary',
          name: 'UploadBlob',
          output,
        },
      ],
      typeName: 'acme.scalar.v1.ScalarService',
    } as const

    const cli = Cli.create('acme').plugin(
      'scalars',
      connectRpc({
        service: service as any,
        transport: { baseUrl: 'https://example.test', protocol: 'connect' },
      }),
    )

    const payload = {
      labels: { team: 'api' },
      profile: { name: 'alice' },
      tags: ['alpha', 'beta'],
    }

    const result = await serve(cli, [
      'scalars',
      'upload-blob',
      '--json',
      JSON.stringify(payload),
      '--format',
      'json',
    ])

    expect(JSON.parse(result.output)).toEqual(payload)
    expect(uploadBlob).toHaveBeenCalledWith(payload, { headers: undefined })
  })
})
