import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { Redis } from 'ioredis';

interface InMemoryRecord {
  totalHits: number;
  expiresAt: number;
}

/**
 * Throttler storage backed by Redis with an in-memory fallback.
 *
 * When Redis is unavailable the storage degrades gracefully to an in-memory
 * store so that read endpoints keep serving instead of failing the request.
 * A warning is logged and a fallback metric is incremented when this happens.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly memory = new Map<string, InMemoryRecord>();
  private fallbackActive = false;

  constructor(private readonly redis: Redis) {}

  /**
   * Records a hit for the given key. Uses Redis when available and falls back
   * to an in-memory store on any Redis error.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const record = await this.incrementRedis(key, ttl, limit, blockDuration, throttlerName);
      if (this.fallbackActive) {
        this.fallbackActive = false;
        this.logger.log('Redis throttler storage recovered; leaving fallback mode');
      }
      return record;
    } catch (error) {
      this.activateFallback(error);
      return this.incrementMemory(key, ttl, limit, blockDuration);
    }
  }

  private async incrementRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `throttler:${throttlerName}:${key}`;
    const results = (await this.redis.multi().incr(redisKey).pttl(redisKey).exec()) as [
      [Error | null, number],
      [Error | null, number],
    ][];

    const totalHits = results[0][1];
    let timeToExpire = results[1][1];

    if (timeToExpire < 0) {
      await this.redis.pexpire(redisKey, ttl);
      timeToExpire = ttl;
    }

    const timeToBlockExpire = totalHits > limit ? blockDuration : 0;
    if (timeToBlockExpire > 0) {
      await this.redis.pexpire(redisKey, blockDuration);
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpire / 1000),
      isBlocked: totalHits > limit,
      timeToBlockExpire: Math.ceil(timeToBlockExpire / 1000),
    };
  }

  private incrementMemory(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): ThrottlerStorageRecord {
    const now = Date.now();
    const existing = this.memory.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.memory.set(key, { totalHits: 1, expiresAt: now + ttl });
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    existing.totalHits += 1;
    const isBlocked = existing.totalHits > limit;
    if (isBlocked) {
      existing.expiresAt = now + blockDuration;
    }

    return {
      totalHits: existing.totalHits,
      timeToExpire: Math.ceil((existing.expiresAt - now) / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }

  private activateFallback(error: unknown): void {
    if (!this.fallbackActive) {
      this.fallbackActive = true;
      this.logger.warn(
        `Redis unavailable for throttler storage; falling back to in-memory store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Whether the storage is currently operating in in-memory fallback mode. */
  isInFallbackMode(): boolean {
    return this.fallbackActive;
  }

  onModuleDestroy(): void {
    this.memory.clear();
  }
}
