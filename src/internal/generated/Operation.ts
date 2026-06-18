import { z } from 'zod'

import type { CommandDefinition } from '../../Cli.js'

/**
 * Example metadata attached to a generated operation.
 */
export type Example = {
  /**
   * Positional example arguments.
   */
  args?: Record<string, unknown> | undefined
  /**
   * Example description.
   */
  description?: string | undefined
  /**
   * Example named options.
   */
  options?: Record<string, unknown> | undefined
}

/**
 * Normalized first-party generated command metadata.
 */
export type Operation<
  args extends z.ZodObject<any> | undefined = undefined,
  options extends z.ZodObject<any> | undefined = undefined,
  output extends z.ZodType | undefined = undefined,
> = {
  /**
   * Positional arguments schema.
   */
  args?: args | undefined
  /**
   * Command description.
   */
  description?: string | undefined
  /**
   * Whether the command is destructive.
   */
  destructive?: boolean | undefined
  /**
   * Structured examples for docs and manifests.
   */
  examples?: Example[] | undefined
  /**
   * Arbitrary generator metadata that should flow through introspection.
   */
  extensions?: Record<string, unknown> | undefined
  /**
   * Plain-text usage hint.
   */
  hint?: string | undefined
  /**
   * Full input payload schema.
   */
  input?: z.ZodObject<any> | undefined
  /**
   * Generator-specific operation kind.
   */
  kind: string
  /**
   * Whether the command mutates external state.
   */
  mutates?: boolean | undefined
  /**
   * Generated command name.
   */
  name: string
  /**
   * Named option schema.
   */
  options?: options | undefined
  /**
   * Output schema.
   */
  output?: output | undefined
  /**
   * Whether the command supports pagination helpers.
   */
  paginate?: boolean | undefined
  /**
   * Command handler.
   */
  run: CommandDefinition<args, undefined, options, output>['run']
}
