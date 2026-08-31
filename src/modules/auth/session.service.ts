import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';

export interface SessionRecord {
  sessionId: string;
  userId: string;
  issuedAt: string;   // ISO-8601
  lastSeen: string;   // ISO-8601
  userAgent: string;
  ipAddress: string;
}

/**
 * Manages lightweight session records stored in Redis alongside the existing
 * JWT blocklist pattern. Each login creates one session entry; logout removes
 * it and blocks the token. Only opaque metadata is exposed — raw tokens are
 * never stored or returned.
 *
 * Redis key layout:
 *   session:<userId>:<sessionId>  → JSON SessionRecord  (TTL = JWT_EXPIRES_IN)
 *   blocklist:<jti>               → "1"                 (TTL = remaining JWT lifetime)
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  /** Key prefix for per-user session records */
  private readonly SESSION_PREFIX = 'session:';
  /** Key prefix for the JWT blocklist */
  private readonly BLOCKLIST_PREFIX = 'blocklist:';

  /** Session TTL matches the JWT lifetime so entries self-expire */
  private readonly sessionTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    const raw = this.config.get<string>('JWT_EXPIRES_IN', '7d');
    this.sessionTtlSeconds = this.parseExpiresIn(raw);
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Create a new session record after a successful login.
   * Returns the opaque sessionId so it can be embedded in the JWT as `jti`.
   */
  async createSession(
    userId: string,
    userAgent: string,
    ipAddress: string,
  ): Promise<string> {
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const record: SessionRecord = {
      sessionId,
      userId,
      issuedAt: now,
      lastSeen: now,
      userAgent: userAgent || 'unknown',
      ipAddress: ipAddress || 'unknown',
    };

    await this.redis.setJson(
      this.sessionKey(userId, sessionId),
      record,
      this.sessionTtlSeconds,
    );

    this.logger.debug(`Session created: ${sessionId} for user ${userId}`);
    return sessionId;
  }

  /**
   * List all active sessions for a user, sorted newest-first.
   */
  async listSessions(userId: string): Promise<SessionRecord[]> {
    const client = this.redis.getClient();
    const pattern = `${this.SESSION_PREFIX}${userId}:*`;

    const keys = await this.scanKeys(client, pattern);
    if (keys.length === 0) return [];

    const pipeline = client.pipeline();
    for (const key of keys) pipeline.get(key);
    const results = await pipeline.exec();

    const sessions: SessionRecord[] = [];
    for (const [err, raw] of results ?? []) {
      if (err || !raw) continue;
      try {
        sessions.push(JSON.parse(raw as string) as SessionRecord);
      } catch {
        // skip malformed entries
      }
    }

    return sessions.sort(
      (a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime(),
    );
  }

  /**
   * Invalidate a single session and add its jti to the blocklist so in-flight
   * requests with that token are immediately rejected by JwtStrategy.
   *
   * @param userId     - owner of the session (for key scoping)
   * @param sessionId  - the jti embedded in the JWT (== sessionId)
   * @param jwtTtlMs   - remaining lifetime of the JWT in milliseconds
   */
  async invalidateSession(
    userId: string,
    sessionId: string,
    jwtTtlMs: number,
  ): Promise<void> {
    await this.redis.del(this.sessionKey(userId, sessionId));

    // Block the token for its remaining lifetime (minimum 1 s to avoid a 0-TTL no-op)
    const ttlSeconds = Math.max(1, Math.ceil(jwtTtlMs / 1000));
    await this.redis.set(this.blocklistKey(sessionId), '1', ttlSeconds);

    this.logger.debug(`Session invalidated: ${sessionId} for user ${userId}`);
  }

  /**
   * Revoke one active session owned by a user.
   * Returns false if the session is already absent.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const key = this.sessionKey(userId, sessionId);
    const session = await this.redis.getJson<SessionRecord>(key);

    if (!session) {
      return false;
    }

    const ttlSeconds = await this.redis.ttl(key);
    const remainingSeconds = ttlSeconds > 0 ? ttlSeconds : 1;

    await this.redis.del(key);
    await this.redis.set(this.blocklistKey(sessionId), '1', remainingSeconds);

    this.logger.debug(`Session revoked: ${sessionId} for user ${userId}`);
    return true;
  }

  /**
   * Check whether a jti is on the blocklist (called by JwtStrategy on every request).
   */
  async isBlocked(jti: string): Promise<boolean> {
    return this.redis.exists(this.blocklistKey(jti));
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private sessionKey(userId: string, sessionId: string): string {
    return `${this.SESSION_PREFIX}${userId}:${sessionId}`;
  }

  private blocklistKey(jti: string): string {
    return `${this.BLOCKLIST_PREFIX}${jti}`;
  }

  /** SCAN-based key enumeration — safe for large Redis keyspaces. */
  private async scanKeys(client: ReturnType<RedisService['getClient']>, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /**
   * Parse JWT_EXPIRES_IN strings like "7d", "24h", "3600" (seconds as string)
   * into a numeric TTL in seconds.
   */
  private parseExpiresIn(value: string): number {
    const match = value.match(/^(\d+)([smhd]?)$/);
    if (!match) return 7 * 24 * 3600; // default 7d
    const n = parseInt(match[1], 10);
    switch (match[2]) {
      case 'd': return n * 86400;
      case 'h': return n * 3600;
      case 'm': return n * 60;
      default:  return n; // plain seconds
    }
  }
}
