import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionLimit: number;
  private readonly poolTimeout: number;

  constructor(config: ConfigService) {
    const isDev = process.env.NODE_ENV !== 'production';
    const connectionLimit = config.get<number>('DATABASE_CONNECTION_LIMIT', 10);
    const poolTimeout = config.get<number>('DATABASE_POOL_TIMEOUT', 10);
    const databaseUrl = config.get<string>('DATABASE_URL', '');
    const separator = databaseUrl.includes('?') ? '&' : '?';
    const url = `${databaseUrl}${separator}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`;

    super({
      datasources: { db: { url } },
      ...(isDev ? { log: [{ emit: 'event', level: 'query' }] } : {}),
    });

    this.connectionLimit = connectionLimit;
    this.poolTimeout = poolTimeout;

    if (isDev) {
      const threshold = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '100', 10);
      (this as any).$on('query', (e: { duration: number; query: string }) => {
        if (e.duration > threshold) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }

  async onModuleInit() {
    // Skip DB connect when exporting OpenAPI for SDK generation
    if (process.env.SDK_GENERATE === '1') {
      this.logger.warn('Skipping database connect (SDK_GENERATE=1)');
      return;
    }
    await this.$connect();
    this.logger.log('Database connected');
    this.logger.log(`Prisma pool: limit=${this.connectionLimit}, timeout=${this.poolTimeout}s`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
