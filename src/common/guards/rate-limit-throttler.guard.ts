import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

export type RateLimitInfo = {
  limit: number;
  remaining: number;
  reset: number;
};

/**
 * Extends ThrottlerGuard so X-RateLimit-* headers are set on both allowed
 * and 429 responses. Stashes rate-limit metadata on the request for the
 * ThrottlerExceptionFilter.
 */
@Injectable()
export class RateLimitThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(
    context: ExecutionContext,
    limit: number,
    ttl: number,
    throttler: any,
    getTracker: any,
    generateKey: any,
  ): Promise<boolean> {
    const { req, res } = this.getRequestResponse(context);
    const ignoreUserAgents = throttler.ignoreUserAgents ?? this.commonOptions.ignoreUserAgents;

    if (Array.isArray(ignoreUserAgents)) {
      for (const pattern of ignoreUserAgents) {
        if (pattern.test(req.headers['user-agent'])) {
          return true;
        }
      }
    }

    const tracker = await getTracker(req);
    const key = generateKey(context, tracker, throttler.name);
    const { totalHits, timeToExpire } = await this.storageService.increment(key, ttl);
    const suffix = throttler.name === 'default' ? '' : `-${throttler.name}`;
    const remaining = Math.max(0, limit - totalHits);
    const reset = Math.max(0, Math.ceil(Number(timeToExpire) || 0));

    const setHeaders = (remainingHits: number) => {
      res.header(`${this.headerPrefix}-Limit${suffix}`, String(limit));
      res.header(`${this.headerPrefix}-Remaining${suffix}`, String(remainingHits));
      res.header(`${this.headerPrefix}-Reset${suffix}`, String(reset));
    };

    if (totalHits > limit) {
      setHeaders(0);
      res.header(`Retry-After${suffix}`, String(reset));
      (req as { rateLimit?: RateLimitInfo }).rateLimit = {
        limit,
        remaining: 0,
        reset,
      };
      await this.throwThrottlingException(context, {
        limit,
        ttl,
        key,
        tracker,
        totalHits,
        timeToExpire: reset,
      });
    }

    setHeaders(remaining);
    (req as { rateLimit?: RateLimitInfo }).rateLimit = {
      limit,
      remaining,
      reset,
    };

    return true;
  }
}
