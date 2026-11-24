import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerLimitDetail } from '@nestjs/throttler';
import { GraphQLError } from 'graphql';
import { RateLimitThrottlerGuard } from './rate-limit-throttler.guard';

/** Stand-in response for GraphQL-over-WebSocket, where there are no HTTP headers to set. */
const NOOP_RESPONSE = { header: () => NOOP_RESPONSE };

/**
 * Global throttler guard that also covers /graphql.
 *
 * ThrottlerGuard reads req/res via `switchToHttp()`, which doesn't work for
 * Apollo resolvers — so GraphQL was an unthrottled path to the same data.
 * This guard pulls req/res from the GraphQL context instead, and otherwise
 * reuses RateLimitThrottlerGuard unchanged: the same Redis storage, the same
 * role/KYC-tiered limits and the same X-RateLimit-* headers as REST.
 *
 * Over-limit GraphQL operations get a GraphQL error with
 * `extensions.code = 'TOO_MANY_REQUESTS'` rather than an HTTP 429 body.
 */
@Injectable()
export class GqlThrottlerGuard extends RateLimitThrottlerGuard {
  getRequestResponse(context: ExecutionContext): {
    req: Record<string, any>;
    res: Record<string, any>;
  } {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return super.getRequestResponse(context);
    }

    const ctx = GqlExecutionContext.create(context).getContext();
    const req = ctx.req ?? { headers: {} };
    const res = ctx.res ?? req.res ?? NOOP_RESPONSE;
    return { req, res };
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return super.throwThrottlingException(context, detail);
    }

    throw new GraphQLError('Too Many Requests', {
      extensions: {
        code: 'TOO_MANY_REQUESTS',
        limit: detail.limit,
        retryAfter: detail.timeToExpire,
      },
    });
  }
}
