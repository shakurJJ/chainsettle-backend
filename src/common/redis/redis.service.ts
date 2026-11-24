import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis service for shared state across pods
 * Used for nonce storage and rate limiting
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    const skipConnect = process.env.SDK_GENERATE === '1';

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: !skipConnect,
      lazyConnect: skipConnect,
      retryStrategy: (times) => {
        if (skipConnect) return null;
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    this.client.on('connect', () => {
      this.logger.log('Redis connected');
    });

    this.client.on('error', (err) => {
      if (skipConnect) return;
      this.logger.error('Redis connection error:', err);
    });

    this.client.on('ready', () => {
      this.logger.log('Redis ready');
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  /**
   * Read and JSON-parse a key. Returns null when missing or unparseable.
   */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * JSON-serialize and store a value. BigInts are written as strings.
   */
  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    await this.set(key, raw, ttlSeconds);
  }

  /**
   * Delete every key starting with `prefix` (SCAN-based, non-blocking).
   */
  async delByPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Set a key with expiration (in seconds)
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * Set a key with expiration (in milliseconds) using Redis native PX.
   */
  async setPx(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(key, value, 'PX', ttlMs);
  }


  /**
   * Get a key
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /**
   * Get TTL of a key (in seconds)
   */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  // ------------------------------------------------------------------
  // Redis Set operations (used for per-user session tracking)
  // ------------------------------------------------------------------

  /**
   * Add one or more members to a Redis set.
   */
  async sadd(key: string, ...members: string[]): Promise<void> {
    await this.client.sadd(key, ...members);
  }

  /**
   * Return all members of a Redis set.
   */
  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  /**
   * Remove one or more members from a Redis set.
   */
  async srem(key: string, ...members: string[]): Promise<void> {
    await this.client.srem(key, ...members);
  }

  // ------------------------------------------------------------------
  // Distributed lock helpers (used by scheduled jobs)
  // ------------------------------------------------------------------

  /**
   * Acquire a distributed lock using SET NX PX.
   * Returns true if the lock was obtained, false if already held.
   */
  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Release a lock only if the caller still owns it (Lua CAS).
   * Safe against accidental release by a different token.
   */
  async releaseLock(key: string, token: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.client.eval(script, 1, key, token);
  }

  /**
   * Extend the TTL of a lock if the caller still owns it.
   * Returns true if the renewal succeeded.
   */
  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.client.eval(script, 1, key, token, String(ttlMs));
    return result === 1;
  }
}
