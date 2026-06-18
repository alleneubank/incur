import type { DescEnum, DescMethod } from '@bufbuild/protobuf'

/**
 * Renders a method-level usage hint.
 */
export function buildHint(method: DescMethod) {
  const hints = ['Use `--json` for nested request fields or full agent payloads.']
  if (method.methodKind === 'server_streaming')
    hints.unshift('Use `--format jsonl` to stream newline-delimited JSON chunks.')
  return hints.join(' ')
}

/**
 * Builds runtime extensions for a generated method.
 */
export function buildExtensions(options: {
  method: DescMethod
  protocol: 'connect' | 'grpc'
  service: string
}) {
  return {
    connectRpc: {
      method: options.method.name,
      methodKind: options.method.methodKind,
      protocol: options.protocol,
      service: options.service,
    },
  }
}

/**
 * Humanizes a Connect method name for CLI help.
 */
export function humanizeMethod(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Resolves mutation metadata for a generated method.
 */
export function resolveMutation(
  method: DescMethod,
  override: { destructive?: boolean | undefined; mutates?: boolean | undefined } | undefined,
) {
  const mutates =
    override?.mutates ?? /^(create|delete|destroy|remove|set|update|write)/i.test(method.localName)
  const destructive = override?.destructive ?? false
  return { destructive, mutates }
}

/**
 * Converts enum value names into CLI-friendly literals.
 */
export function enumLiteral(desc: DescEnum, name: string) {
  const prefix = enumPrefix(desc)
  const normalizedName = name.toUpperCase()
  const normalizedPrefix = prefix.toUpperCase()
  const trimmed = normalizedName.startsWith(normalizedPrefix)
    ? normalizedName.slice(normalizedPrefix.length)
    : normalizedName
  return trimmed.toLowerCase().replaceAll('_', '-')
}

/**
 * Converts enum numbers into CLI-friendly literals.
 */
export function enumName(desc: DescEnum, value: number) {
  const resolved = desc.value[value]
  return enumLiteral(desc, resolved?.name ?? desc.values[0]?.name ?? 'UNSPECIFIED')
}

/**
 * Converts camelCase or snake_case names into kebab-case CLI commands.
 */
export function toKebab(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase()
}

/**
 * Converts mixed-case values into screaming snake case.
 */
export function toSnake(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toUpperCase()
}

function enumPrefix(desc: DescEnum) {
  if (desc.sharedPrefix) return desc.sharedPrefix
  const names = desc.values.map((value) => value.name)
  if (names.length === 0) return ''
  let prefix = names[0] ?? ''
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix) && prefix.length > 0) prefix = prefix.slice(0, -1)
  }
  const underscore = prefix.lastIndexOf('_')
  return underscore === -1 ? '' : prefix.slice(0, underscore + 1)
}
