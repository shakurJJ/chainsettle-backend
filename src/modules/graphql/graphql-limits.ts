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
