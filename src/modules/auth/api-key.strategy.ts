import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

export const API_KEY_USAGE_PREFIX = 'chainsettle:api-key:usage:';
export const API_KEY_USAGE_TTL_SECONDS = 31 * 24 * 60 * 60; // 31 days

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async validate(req: Request) {
    const rawKey = req.headers['x-api-key'];

    if (!rawKey || typeof rawKey !== 'string') {
      throw new UnauthorizedException('Missing X-Api-Key header');
    }

    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { user: true },
    });

    if (!apiKey) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    // A revoked key is still allowed during its grace period (rotation window).
    // Once gracePeriodEndsAt has passed — or if there is no grace period —
    // treat it as fully revoked.
    if (apiKey.revokedAt !== null) {
      const now = new Date();
      const inGracePeriod =
        apiKey.gracePeriodEndsAt !== null && apiKey.gracePeriodEndsAt > now;

      if (!inGracePeriod) {
        throw new UnauthorizedException('Invalid or revoked API key');
      }
    }

    // Reject keys that have passed their expiry date
    if (apiKey.expiresAt !== null && apiKey.expiresAt <= new Date()) {
      throw new UnauthorizedException('API_KEY_EXPIRED');
    }

    if (apiKey.user?.deactivatedAt) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    // Fire-and-forget — don't block the request on this update
    this.prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => null);

    // Record daily request usage in Redis (expires after 31 days)
    const today = new Date().toISOString().slice(0, 10);
    const usageKey = `${API_KEY_USAGE_PREFIX}${apiKey.id}:${today}`;
    const client = this.redis.getClient();
    client
      .incr(usageKey)
      .then((val) => {
        if (val === 1) {
          client.expire(usageKey, API_KEY_USAGE_TTL_SECONDS).catch(() => null);
        }
      })
      .catch(() => null);

    // Attach scopes alongside the user so ApiKeyGuard can enforce least-privilege.
    // The _apiKeyScopes property is only present when auth was performed via API key
    // (not JWT), so guards can detect the auth method if needed.
    return {
      ...apiKey.user,
      _apiKeyScopes: apiKey.scopes as string[],
    };
  }
}
