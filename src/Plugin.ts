import { z } from 'zod'

import type { Cli, CommandsMap } from './Cli.js'

/**
 * Context passed to a plugin when it resolves its generated command subtree.
 */
export type Context<config extends z.ZodObject<any> | undefined = undefined> = {
  /**
   * Working directory of the host process.
   */
  cwd: string
  /**
   * Parsed plugin configuration.
   */
  config: config extends z.ZodObject<any> ? z.output<config> : undefined
  /**
   * Mount path chosen by the CLI author.
   */
  mount: string
}

/**
 * A generator-style plugin that resolves to a normal incur command group.
 */
export type Plugin<
  config extends z.ZodObject<any> | undefined = undefined,
  commands extends CommandsMap = {},
> = {
  /**
   * Plugin name for diagnostics and docs.
   */
  name: string
  /**
   * Optional plugin description.
   */
  description?: string | undefined
  /**
   * Optional schema used to validate the plugin options before resolution.
   */
  config?: config | undefined
  /**
   * Raw plugin options validated against `config` before `resolve()`.
   */
  options?: (config extends z.ZodObject<any> ? z.input<config> : never) | undefined
  /**
   * Resolves the mounted command subtree.
   */
  resolve(context: Context<config>): Promise<Cli<commands, any, any> & { name: string }>
}
