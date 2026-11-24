import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/redis/redis.service';

/**
 * SessionService
 *
 * Manages the lifecycle of JWT sessions via Redis:
 *
 *  • Each JWT is given a unique `jti` (JWT ID) at issuance.
 *  • The jti is stored in a Redis set keyed by user ID so we know
 *    every active session for a given user.
 *  • Revoked jtis are added to a blocklist key; the JwtStrategy
 *    rejects any token whose jti appears in the blocklist.
 *
 * Key schema:
 *   chainsettle:sessions:{userId}   → Redis Set of active jtis
 *   chainsettle:blocklist:{jti}     → "1" with TTL = remaining token lifetime
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  readonly SESSION_SET_PREFIX = 'chainsettle:sessions:';
  readonly BLOCKLIST_PREFIX = 'chainsettle:blocklist:';

  /** JWT TTL in seconds — must match what JwtModule is configured with. */
  private readonly jwtTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '7d');
    this.jwtTtlSeconds = this.parseExpiry(expiresIn);
  }

  // ------------------------------------------------------------------
  // Session registration (called at login)
  // ------------------------------------------------------------------

  /**
   * Register a newly issued JWT session so it can be enumerated later.
   */
  async registerSession(userId: string, jti: string): Promise<void> {
    const key = `${this.SESSION_SET_PREFIX}${userId}`;
    await this.redis.sadd(key, jti);
    this.logger.debug(`Session registered: jti=${jti} for userId=${userId}`);
  }

  // ------------------------------------------------------------------
  // Revocation
  // ------------------------------------------------------------------

  /**
   * Revoke all active sessions for a user, optionally excluding the
   * caller's own current session.
   *
   * For each revoked jti:
   *  1. Adds it to the Redis blocklist (TTL = JWT lifetime).
   *  2. Removes it from the user's active-session set.
   *
   * @returns Number of sessions actually revoked
   */
  async revokeAllSessions(
    userId: string,
    currentJti: string,
    includeCurrent: boolean,
  ): Promise<number> {
    const key = `${this.SESSION_SET_PREFIX}${userId}`;
    const allJtis = await this.redis.smembers(key);

    const jtisToRevoke = includeCurrent
      ? allJtis
      : allJtis.filter((jti) => jti !== currentJti);

    if (jtisToRevoke.length === 0) {
      return 0;
    }

    // Blocklist each jti and remove from the session set in parallel
    await Promise.all(
      jtisToRevoke.map((jti) =>
        this.redis.set(
          `${this.BLOCKLIST_PREFIX}${jti}`,
          '1',
          this.jwtTtlSeconds,
        ),
      ),
    );

    await this.redis.srem(key, ...jtisToRevoke);

    this.logger.log(
      `Revoked ${jtisToRevoke.length} session(s) for userId=${userId} (includeCurrent=${includeCurrent})`,
    );

    return jtisToRevoke.length;
  }

  // ------------------------------------------------------------------
  // Blocklist check (called by JwtStrategy on every authenticated request)
  // ------------------------------------------------------------------

  /**
   * Returns true if the given jti has been revoked (is on the blocklist).
   */
  async isRevoked(jti: string): Promise<boolean> {
    return this.redis.exists(`${this.BLOCKLIST_PREFIX}${jti}`);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Parse a JWT expiry string (e.g. "7d", "24h", "3600") into seconds.
   */
  private parseExpiry(expiry: string): number {
    const match = /^(\d+)([smhd]?)$/.exec(expiry);
    if (!match) return 7 * 24 * 60 * 60; // default: 7 days

    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';

    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return value * (multipliers[unit] ?? 1);
  }
}
