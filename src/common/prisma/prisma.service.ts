import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionLimit: number;
  private readonly poolTimeout: number;
  /** Optional read-replica client. When unset, `read` returns the primary. */
  private replicaClient: PrismaClient | null = null;

  constructor(config: ConfigService) {
    const isDev = process.env.NODE_ENV !== 'production';
    const connectionLimit = config.get<number>('DATABASE_CONNECTION_LIMIT', 10);
    const poolTimeout = config.get<number>('DATABASE_POOL_TIMEOUT', 10);
    const databaseUrl = config.get<string>('DATABASE_URL', '');
    const url = PrismaService.withPoolParams(databaseUrl, connectionLimit, poolTimeout);

    super({
      datasources: { db: { url } },
      ...(isDev ? { log: [{ emit: 'event', level: 'query' }] } : {}),
    });

    this.connectionLimit = connectionLimit;
    this.poolTimeout = poolTimeout;

    const replicaUrl = config.get<string>('DATABASE_REPLICA_URL');
    if (replicaUrl) {
      const replicaPooled = PrismaService.withPoolParams(
        replicaUrl,
        connectionLimit,
        poolTimeout,
      );
      this.replicaClient = new PrismaClient({
        datasources: { db: { url: replicaPooled } },
      });
      this.logger.log('DATABASE_REPLICA_URL configured — read client will use the replica');
    }

    if (isDev) {
      const threshold = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '100', 10);
      (this as any).$on('query', (e: { duration: number; query: string }) => {
        if (e.duration > threshold) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }

  /**
   * Prisma client for clearly read-only queries.
   * Falls back to the primary when DATABASE_REPLICA_URL is unset.
   *
   * Eventual consistency: a just-written row may not yet be visible on the
   * replica. Prefer `this` (primary) for read-your-writes paths.
   */
  get read(): PrismaClient {
    return this.replicaClient ?? this;
  }

  get isReplicaEnabled(): boolean {
    return this.replicaClient !== null;
  }

  private static withPoolParams(
    databaseUrl: string,
    connectionLimit: number,
    poolTimeout: number,
  ): string {
    const separator = databaseUrl.includes('?') ? '&' : '?';
    return `${databaseUrl}${separator}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`;
  }

  async onModuleInit() {
    // Skip DB connect when exporting OpenAPI for SDK generation
    if (process.env.SDK_GENERATE === '1') {
      this.logger.warn('Skipping database connect (SDK_GENERATE=1)');
      return;
    }
    await this.$connect();
    this.logger.log('Database connected (primary)');
    this.logger.log(`Prisma pool: limit=${this.connectionLimit}, timeout=${this.poolTimeout}s`);

    if (this.replicaClient) {
      await this.replicaClient.$connect();
      this.logger.log('Database connected (replica)');
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected (primary)');
    if (this.replicaClient) {
      await this.replicaClient.$disconnect();
      this.logger.log('Database disconnected (replica)');
    }
  }
}
