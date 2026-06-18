import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const controlCharPattern = /[\u0000-\u001f\u007f]/

/** Whether a string contains ASCII control characters. */
export function hasControlChars(value: string): boolean {
  return controlCharPattern.test(value)
}

/** Whether a string is allowed to contain control characters by schema metadata. */
export function allowsControlChars(schema: z.ZodType): boolean {
  return schema.meta()?.allowControlChars === true
}

/** Shared hardened string schema helpers. */
export const hardened = {
  /** Validates a relative path that must stay within the current working directory. */
  path() {
    return z.string().superRefine((value, ctx) => {
      const issue = validatePath(value)
      if (issue)
        ctx.addIssue({
          code: 'custom',
          message: issue,
        })
    })
  },

  /** Validates a resource identifier that must not contain URL-breaking characters. */
  id() {
    return z.string().superRefine((value, ctx) => {
      if (hasControlChars(value))
        ctx.addIssue({ code: 'custom', message: 'Identifier contains invalid control characters' })
      if (value.includes('?'))
        ctx.addIssue({ code: 'custom', message: "Identifier must not contain '?'" })
      if (value.includes('#'))
        ctx.addIssue({ code: 'custom', message: "Identifier must not contain '#'" })
      if (value.includes('%'))
        ctx.addIssue({ code: 'custom', message: "Identifier must not contain '%'" })
    })
  },

  /** Validates free-form text that must not contain ASCII control characters. */
  text() {
    return z.string().superRefine((value, ctx) => {
      if (hasControlChars(value))
        ctx.addIssue({ code: 'custom', message: 'Text contains invalid control characters' })
    })
  },

  /** Validates URLs against control chars and encoded traversal patterns. */
  url() {
    return z.string().superRefine((value, ctx) => {
      if (hasControlChars(value))
        ctx.addIssue({ code: 'custom', message: 'URL contains invalid control characters' })
      if (hasEncodedTraversal(value))
        ctx.addIssue({ code: 'custom', message: 'URL contains encoded traversal patterns' })
    })
  },
}

function validatePath(value: string): string | undefined {
  if (hasControlChars(value)) return 'Path contains invalid control characters'
  if (path.isAbsolute(value)) return 'Path must be a relative path'

  const parts = value.split(/[\\/]+/)
  if (parts.some((part) => part === '..')) return "Path must not contain traversal ('..') segments"

  const cwd = realpathSync(process.cwd())
  const resolved = path.resolve(cwd, value)
  const canonical = resolvePathWithinCwd(resolved)

  if (!isWithin(canonical, cwd)) return 'Path resolves outside the current directory'
  return undefined
}

function resolvePathWithinCwd(target: string): string {
  if (existsSync(target)) return realpathSync(target)

  const pending: string[] = []
  let current = target
  while (!existsSync(current)) {
    const base = path.basename(current)
    if (!base) break
    pending.push(base)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  let resolved = realpathSync(current)
  for (const segment of pending.reverse()) resolved = path.join(resolved, segment)
  return resolved
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function hasEncodedTraversal(value: string): boolean {
  const lowered = value.toLowerCase()
  if (lowered.includes('%2e%2e') || lowered.includes('%252e%252e')) return true

  let current = value
  for (let i = 0; i < 2; i++) {
    if (!current.includes('%')) break
    try {
      current = decodeURIComponent(current)
    } catch {
      return true
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(current)) return true
  }

  return false
}
