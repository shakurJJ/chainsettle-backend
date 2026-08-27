import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis-based storage for @nestjs/throttler
 * Ensures rate limits are consistent across multiple pods/instances
 */
@Injectable()
export class RedisThrottlerStorageService implements ThrottlerStorage, OnModuleDestroy {
  private redis: Redis;
  private readonly prefix = 'throttle:';

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    const skipConnect = process.env.SDK_GENERATE === '1';
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: !skipConnect,
      lazyConnect: skipConnect,
      retryStrategy: skipConnect ? () => null : undefined,
    });

    this.redis.on('error', (err) => {
      if (skipConnect) return;
      console.error('Redis Throttler Storage Error:', err);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async increment(key: string, ttl: number): Promise<{ totalHits: number; timeToExpire: number }> {
    const redisKey = `${this.prefix}${key}`;
    
    try {
      const multi = this.redis.multi();
      multi.incr(redisKey);
      multi.pexpire(redisKey, ttl);
      multi.pttl(redisKey);
      
      const results = await multi.exec();
      
      if (!results) {
        throw new Error('Redis multi command failed');
      }

      const totalHits = results[0][1] as number;
      const timeToExpire = results[2][1] as number;

      return {
        totalHits,
        timeToExpire: timeToExpire > 0 ? timeToExpire : 0,
      };
    } catch (error) {
      console.error('Redis increment error:', error);
      // Fallback: allow the request if Redis is down
      return { totalHits: 0, timeToExpire: 0 };
    }
  }
}
