import type { CommandDefinition, CommandEntry, InternalGroup, OutputPolicy } from '../../Cli.js'
import type { Handler as MiddlewareHandler } from '../../middleware.js'
import type { Operation } from './Operation.js'

/**
 * Converts a normalized generated operation into a CLI command entry.
 */
export function toCommandEntry(operation: Operation): CommandDefinition<any, any, any> {
  return {
    ...(operation.args ? { args: operation.args } : undefined),
    ...(operation.description ? { description: operation.description } : undefined),
    ...(operation.destructive ? { destructive: true } : undefined),
    ...(operation.examples ? { examples: operation.examples } : undefined),
    ...(operation.extensions ? { extensions: operation.extensions } : undefined),
    ...(operation.hint ? { hint: operation.hint } : undefined),
    ...(operation.input ? { input: operation.input } : undefined),
    ...(operation.mutates ? { mutates: true } : undefined),
    ...(operation.options ? { options: operation.options } : undefined),
    ...(operation.output ? { output: operation.output } : undefined),
    ...(operation.paginate ? { paginate: true } : undefined),
    run: operation.run,
  }
}

/**
 * Converts generated operations into a command-entry map.
 */
export function toCommandEntries(operations: Operation[]) {
  return operations.reduce((commands, operation) => {
    if (commands.has(operation.name))
      throw new Error(`Duplicate generated command name '${operation.name}'`)
    commands.set(operation.name, toCommandEntry(operation))
    return commands
  }, new Map<string, CommandEntry>())
}

/**
 * Mounts generated operations into an existing command-entry map.
 */
export function mountOperations(commands: Map<string, CommandEntry>, operations: Operation[]) {
  for (const [name, entry] of toCommandEntries(operations)) {
    if (commands.has(name)) throw new Error(`Duplicate generated command name '${name}'`)
    commands.set(name, entry)
  }
}

/**
 * Builds an internal command group from an existing command-entry map.
 */
export function toInternalGroup(options: {
  commands: Map<string, CommandEntry>
  description?: string | undefined
  middlewares?: MiddlewareHandler[] | undefined
  outputPolicy?: OutputPolicy | undefined
}): InternalGroup {
  return {
    _group: true,
    commands: options.commands,
    ...(options.description ? { description: options.description } : undefined),
    ...(options.middlewares?.length ? { middlewares: options.middlewares } : undefined),
    ...(options.outputPolicy ? { outputPolicy: options.outputPolicy } : undefined),
  }
}
