import {
  buildClientSchema,
  buildSchema,
  type GraphQLSchema,
  isSchema,
  type IntrospectionQuery,
} from 'graphql'

/**
 * Accepted GraphQL schema sources for the first-party plugin.
 */
export type SchemaSource =
  | GraphQLSchema
  | IntrospectionQuery
  | { __schema: IntrospectionQuery['__schema'] }
  | { data: IntrospectionQuery | { __schema: IntrospectionQuery['__schema'] } }
  | string

/**
 * Loads a GraphQL schema from introspection, SDL, or a prebuilt schema artifact.
 */
export function loadSchema(source: SchemaSource) {
  if (isSchema(source)) return source
  if (typeof source === 'string') return buildSchema(source)
  if ('data' in source)
    return loadSchema(
      '__schema' in source.data
        ? (source.data as { __schema: IntrospectionQuery['__schema'] })
        : (source.data as IntrospectionQuery),
    )
  if ('__schema' in source) return buildClientSchema(source as IntrospectionQuery)
  return buildClientSchema(source)
}
