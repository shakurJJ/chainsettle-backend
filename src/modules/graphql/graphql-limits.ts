import {
  ASTVisitor,
  FragmentDefinitionNode,
  GraphQLError,
  GraphQLSchema,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  isListType,
  getNullableType,
} from 'graphql';
import { ComplexityEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import type { ApolloServerPlugin } from '@apollo/server';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';

/** Cost multiplier applied to list fields without an explicit `limit` argument. */
export const DEFAULT_LIST_SIZE = 10;

/**
 * Rejects operations whose selection sets nest deeper than `maxDepth` (#432).
 * Introspection fields (`__schema`, `__type`) are not counted.
 */
export function depthLimitRule(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    }

    const measure = (set: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
      if (!set) return depth;
      let max = depth;
      for (const sel of set.selections) {
        if (sel.kind === Kind.FIELD) {
          if (sel.name.value.startsWith('__')) continue;
          max = Math.max(max, measure(sel.selectionSet, depth + 1, seen));
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          max = Math.max(max, measure(sel.selectionSet, depth, seen));
        } else if (sel.kind === Kind.FRAGMENT_SPREAD && !seen.has(sel.name.value)) {
          const frag = fragments.get(sel.name.value);
          if (frag) max = Math.max(max, measure(frag.selectionSet, depth, new Set([...seen, sel.name.value])));
        }
      }
      return max;
    };

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = measure(node.selectionSet, 0, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}`, {
              nodes: [node],
              extensions: { code: 'QUERY_TOO_DEEP', depth, maxDepth },
            }),
          );
        }
      },
    };
  };
}

/** List fields cost their children times the requested page size (or a default). */
export const listEstimator: ComplexityEstimator = ({ field, args, childComplexity }) => {
  if (!isListType(getNullableType(field.type))) return undefined;
  const size = typeof args?.limit === 'number' && args.limit > 0 ? args.limit : DEFAULT_LIST_SIZE;
  return size * (1 + childComplexity);
};

export function computeComplexity(schema: GraphQLSchema, query: any, variables: Record<string, any> = {}, operationName?: string) {
  return getComplexity({
    schema,
    query,
    variables,
    operationName,
    estimators: [listEstimator, simpleEstimator({ defaultComplexity: 1 })],
  });
}

/**
 * Apollo plugin that estimates query cost after validation and refuses to
 * execute operations over `maxComplexity`, reporting the computed cost (#432).
 */
export function complexityLimitPlugin(maxComplexity: number): ApolloServerPlugin {
  return {
    async requestDidStart({ schema }) {
      return {
        async didResolveOperation({ request, document }) {
          const complexity = computeComplexity(schema, document, request.variables ?? {}, request.operationName ?? undefined);
          if (complexity > maxComplexity) {
            throw new GraphQLError(
              `Query complexity ${complexity} exceeds the maximum allowed complexity of ${maxComplexity}`,
              { extensions: { code: 'QUERY_TOO_COMPLEX', complexity, maxComplexity } },
            );
          }
        },
      };
    },
  };
}

/** Minimal Redis surface the persisted-query plugin depends on. */
export interface PersistedQueryCache {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds?: number): Promise<unknown>;
}

export interface PersistedQueriesOptions {
  /** Redis-backed cache used to store query text keyed by sha256 hash. */
  cache: PersistedQueryCache;
  /** Key prefix for stored queries. Defaults to `graphql:apq:`. */
  keyPrefix?: string;
  /** TTL in seconds for cached queries. Defaults to 24 hours. */
  ttlSeconds?: number;
  /** When true, only allowlisted or previously registered queries are executed. */
  persistedOnly?: boolean;
  /** Path to a JSON file containing an array of allowed sha256 hashes. */
  allowlistPath?: string;
}

export const APQ_KEY_PREFIX = 'graphql:apq:';
export const APQ_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Computes the sha256 hex digest of a query string, as used by Apollo APQ. */
export function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

/** Loads an allowlist of sha256 hashes from a JSON file, if it exists. */
export function loadAllowlist(path?: string): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((h): h is string => typeof h === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Apollo plugin implementing Automatic Persisted Queries (#671).
 *
 * - Unknown hash + no query text -> `PERSISTED_QUERY_NOT_FOUND` (client retries with text).
 * - Known hash + query text -> registers the query text in the cache.
 * - `persistedOnly` -> rejects any operation whose hash is neither cached nor allowlisted
 *   with `PERSISTED_QUERY_NOT_ALLOWED`.
 */
export function persistedQueriesPlugin(options: PersistedQueriesOptions): ApolloServerPlugin {
  const prefix = options.keyPrefix ?? APQ_KEY_PREFIX;
  const ttl = options.ttlSeconds ?? APQ_DEFAULT_TTL_SECONDS;
  const allowlist = loadAllowlist(options.allowlistPath);

  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request }) {
          const extensions = (request.extensions ?? {}) as Record<string, any>;
          const persisted = extensions.persistedQuery as { sha256Hash?: string } | undefined;
          const hash = persisted?.sha256Hash;
          const query = request.query;

          if (!hash) {
            if (options.persistedOnly) {
              throw new GraphQLError('Persisted queries are required', {
                extensions: { code: 'PERSISTED_QUERY_NOT_ALLOWED' },
              });
            }
            return;
          }

          const key = `${prefix}${hash}`;
          const cached = await options.cache.get(key);

          if (query) {
            // Client supplied the full text: register it for future lookups.
            await options.cache.set(key, query, ttl);
            return;
          }

          if (cached) {
            request.query = cached;
            return;
          }

          if (options.persistedOnly && allowlist.has(hash)) {
            throw new GraphQLError('Persisted query not found', {
              extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' },
            });
          }

          if (options.persistedOnly) {
            throw new GraphQLError('Persisted query is not allowed', {
              extensions: { code: 'PERSISTED_QUERY_NOT_ALLOWED' },
            });
          }

          throw new GraphQLError('PersistedQueryNotFound', {
            extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' },
          });
        },
      };
    },
  };
}
