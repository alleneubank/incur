/** Result of output sanitization. */
export type Result = {
  blocked: boolean
  output: unknown
  warnings?: string[] | undefined
}

const patterns = ['ignore previous instructions', 'system prompt:', 'developer message:'] as const

/** Scans output for obvious prompt injection strings. */
export function scan(output: unknown): string[] {
  const warnings = new Set<string>()
  for (const value of collectStrings(output)) {
    const lowered = value.toLowerCase()
    for (const pattern of patterns)
      if (lowered.includes(pattern))
        warnings.add(`Potential prompt injection content detected: ${pattern}`)
  }
  return [...warnings]
}

/** Runs the built-in scanner and optional custom sanitizer. */
export async function sanitize(
  output: unknown,
  context: { agent: boolean; command: string },
  fn:
    | ((output: unknown, context: { command: string; agent: boolean }) => Promise<Result>)
    | undefined,
): Promise<Result> {
  const builtinWarnings = context.agent ? scan(output) : []
  if (!fn)
    return {
      output,
      blocked: false,
      ...(builtinWarnings.length ? { warnings: builtinWarnings } : undefined),
    }

  const result = await fn(output, context)
  const warnings = [...new Set([...(builtinWarnings ?? []), ...(result.warnings ?? [])])]
  return {
    output: result.output,
    blocked: result.blocked,
    ...(warnings.length ? { warnings } : undefined),
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}
