import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

export type RateLimitInfo = {
  limit: number;
  remaining: number;
  reset: number;
};

/**
 * Extends ThrottlerGuard so X-RateLimit-* headers are set on both allowed
 * and 429 responses. Stashes rate-limit metadata on the request for the
 * ThrottlerExceptionFilter.
 *
 * For authenticated users, the effective limit can be raised when they are
 * KYC-verified or have elevated admin access. The tiers are configured via
 * THROTTLE_LIMIT, THROTTLE_LIMIT_VERIFIED, and THROTTLE_LIMIT_ADMIN.
 */
@Injectable()
export class RateLimitThrottlerGuard extends ThrottlerGuard {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  private getTierLimit(tier: 'default' | 'verified' | 'admin', fallbackLimit: number): number {
    const envKey =
      tier === 'admin'
        ? 'THROTTLE_LIMIT_ADMIN'
        : tier === 'verified'
          ? 'THROTTLE_LIMIT_VERIFIED'
          : 'THROTTLE_LIMIT';

    const configured = this.config.get<number | string>(envKey, fallbackLimit);
    const parsed = Number(configured ?? fallbackLimit);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackLimit;
  }

  private async resolveEffectiveLimit(req: any, defaultLimit: number): Promise<number> {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      return this.getTierLimit('default', defaultLimit);
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, kycStatus: true },
      });

      if (!user) {
        return this.getTierLimit('default', defaultLimit);
      }

      if (user.role === 'ADMIN') {
        return this.getTierLimit('admin', defaultLimit);
      }

      if (user.kycStatus === 'VERIFIED') {
        return this.getTierLimit('verified', defaultLimit);
      }
    } catch {
      // Fall back to the default limit if the user record cannot be read.
    }

    return this.getTierLimit('default', defaultLimit);
  }

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

    const effectiveLimit = await this.resolveEffectiveLimit(req, limit);
    const tracker = await getTracker(req);
    const key = generateKey(context, tracker, throttler.name);
    const { totalHits, timeToExpire } = await this.storageService.increment(key, ttl);
    const suffix = throttler.name === 'default' ? '' : `-${throttler.name}`;
    const remaining = Math.max(0, effectiveLimit - totalHits);
    const reset = Math.max(0, Math.ceil(Number(timeToExpire) || 0));

    const setHeaders = (remainingHits: number) => {
      res.header(`${this.headerPrefix}-Limit${suffix}`, String(effectiveLimit));
      res.header(`${this.headerPrefix}-Remaining${suffix}`, String(remainingHits));
      res.header(`${this.headerPrefix}-Reset${suffix}`, String(reset));
    };

    if (totalHits > effectiveLimit) {
      setHeaders(0);
      res.header(`Retry-After${suffix}`, String(reset));
      (req as { rateLimit?: RateLimitInfo }).rateLimit = {
        limit: effectiveLimit,
        remaining: 0,
        reset,
      };
      await this.throwThrottlingException(context, {
        limit: effectiveLimit,
        ttl,
        key,
        tracker,
        totalHits,
        timeToExpire: reset,
      });
    }

    setHeaders(remaining);
    (req as { rateLimit?: RateLimitInfo }).rateLimit = {
      limit: effectiveLimit,
      remaining,
      reset,
    };

    return true;
  }
}
