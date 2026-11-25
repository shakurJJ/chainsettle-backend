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
  /** Client with a longer statement timeout for jobs and exports (lazy). */
  private jobsClient: PrismaClient | null = null;
  private readonly jobsUrl: string;

  constructor(config: ConfigService) {
    const isDev = process.env.NODE_ENV !== 'production';
    const connectionLimit = config.get<number>('DATABASE_CONNECTION_LIMIT', 10);
    const poolTimeout = config.get<number>('DATABASE_POOL_TIMEOUT', 10);
    const databaseUrl = config.get<string>('DATABASE_URL', '');
    const statementTimeout = config.get<number>('DB_STATEMENT_TIMEOUT_MS', 30000);
    const jobStatementTimeout = config.get<number>('DB_JOB_STATEMENT_TIMEOUT_MS', 300000);
    const url = PrismaService.withStatementTimeout(
      PrismaService.withPoolParams(databaseUrl, connectionLimit, poolTimeout),
      statementTimeout,
    );

    super({
      datasources: { db: { url } },
      ...(isDev ? { log: [{ emit: 'event', level: 'query' }] } : {}),
    });

    this.connectionLimit = connectionLimit;
    this.poolTimeout = poolTimeout;
    this.jobsUrl = PrismaService.withStatementTimeout(
      PrismaService.withPoolParams(databaseUrl, Math.max(2, Math.ceil(connectionLimit / 2)), poolTimeout),
      jobStatementTimeout,
    );

    const replicaUrl = config.get<string>('DATABASE_REPLICA_URL');
    if (replicaUrl) {
      const replicaPooled = PrismaService.withStatementTimeout(
        PrismaService.withPoolParams(replicaUrl, connectionLimit, poolTimeout),
        statementTimeout,
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

  /**
   * Prisma client for background jobs and large exports. Uses
   * DB_JOB_STATEMENT_TIMEOUT_MS instead of the stricter API timeout.
   */
  get jobs(): PrismaClient {
    if (!this.jobsClient) {
      this.jobsClient = new PrismaClient({ datasources: { db: { url: this.jobsUrl } } });
    }
    return this.jobsClient;
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

  /** Applies a server-side statement_timeout via the libpq `options` parameter. */
  static withStatementTimeout(url: string, timeoutMs: number): string {
    if (!timeoutMs || timeoutMs <= 0) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}options=${encodeURIComponent(`-c statement_timeout=${timeoutMs}`)}`;
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
    if (this.jobsClient) {
      await this.jobsClient.$disconnect();
    }
  }
}
