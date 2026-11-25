import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { MetricsService } from '../metrics/metrics.service';
import { QUEUE_NAMES, QueueName } from './queue.constants';
import { JobQueuePolicy, resolveQueuePolicies } from './queue-policy';

/** Queue states exposed by the admin view and the depth gauge. */
export const QUEUE_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
] as const;

export type QueueState = (typeof QUEUE_STATES)[number];
export type QueueCounts = Record<QueueState, number>;

export function isQueueState(value: string): value is QueueState {
  return (QUEUE_STATES as readonly string[]).includes(value);
}

export interface QueueStats {
  name: QueueName;
  policy: JobQueuePolicy;
  counts: QueueCounts;
}

export interface QueueJobSummary {
  id: string;
  name: string;
  state: string;
  attemptsMade: number;
  maxAttempts: number | null;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
}

const EMPTY_COUNTS: QueueCounts = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
};

/**
 * Owns the Redis-backed BullMQ queues (#661). Jobs are persisted in Redis, so
 * a restart no longer loses queued work, and failed jobs are retried with
 * exponential back-off according to their queue's policy.
 *
 * Workers run in-process next to the API: each feature owns its processor and
 * creates its worker here, which keeps concurrency and metrics consistent.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connections: Redis[] = [];
  private readonly policies: Record<QueueName, JobQueuePolicy>;
  private readonly prefix: string;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.policies = resolveQueuePolicies(config);
    this.prefix = config.get<string>('QUEUE_PREFIX', 'chainsettle');
    this.enabled = this.resolveEnabled(config);

    if (!this.enabled) {
      this.logger.warn(
        'BullMQ queues are disabled (QUEUE_ENABLED=false or SDK_GENERATE=1) — background work falls back to in-process handling',
      );
      return;
    }

    const connection = this.createConnection();

    for (const name of QUEUE_NAMES) {
      this.queues.set(
        name,
        new Queue(name, {
          connection,
          prefix: this.prefix,
          defaultJobOptions: this.jobOptions(name),
        }),
      );
    }
  }

  private resolveEnabled(config: ConfigService): boolean {
    if (process.env.SDK_GENERATE === '1') return false;
    const raw = config.get<string | boolean>('QUEUE_ENABLED', true);
    return raw !== false && raw !== 'false';
  }

  private redisUrl(): string {
    return this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
  }

  /**
   * BullMQ requires blocking connections that retry forever, so every queue
   * and worker connection is created here and closed on shutdown.
   */
  private createConnection(label = ''): Redis {
    const connection = new Redis(this.redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    connection.on('error', (err) =>
      this.logger.error(`${label}Redis connection error: ${err.message}`),
    );
    this.connections.push(connection);
    return connection;
  }

  private jobOptions(name: QueueName): JobsOptions {
    const policy = this.policies[name];
    return {
      attempts: policy.attempts,
      backoff: { type: 'exponential', delay: policy.backoffMs },
      removeOnComplete: { age: 24 * 60 * 60, count: 500 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPolicy(name: QueueName): JobQueuePolicy {
    return { ...this.policies[name] };
  }

  /** Adds a job, applying the queue's default retry policy. */
  async add<T>(
    name: QueueName,
    jobName: string,
    data: T,
    options?: JobsOptions,
  ): Promise<Job<T> | null> {
    if (!this.enabled) return null;
    const queue = this.queues.get(name);
    if (!queue) return null;
    return (await queue.add(jobName, data, options)) as Job<T>;
  }

  async getJob<T>(name: QueueName, jobId: string): Promise<Job<T> | null> {
    if (!this.enabled) return null;
    const queue = this.queues.get(name);
    if (!queue) return null;
    const job = await queue.getJob(jobId);
    return (job as Job<T> | undefined) ?? null;
  }

  async getCounts(name: QueueName): Promise<QueueCounts> {
    if (!this.enabled) return { ...EMPTY_COUNTS };
    const queue = this.queues.get(name);
    if (!queue) return { ...EMPTY_COUNTS };
    const counts = await queue.getJobCounts(...QUEUE_STATES);
    return { ...EMPTY_COUNTS, ...counts } as QueueCounts;
  }

  async getStats(): Promise<QueueStats[]> {
    return Promise.all(
      QUEUE_NAMES.map(async (name) => ({
        name,
        policy: this.getPolicy(name),
        counts: await this.getCounts(name),
      })),
    );
  }

  async listJobs(
    name: QueueName,
    states: QueueState[],
    limit = 20,
  ): Promise<QueueJobSummary[]> {
    if (!this.enabled) return [];
    const queue = this.queues.get(name);
    if (!queue) return [];

    const jobs = await queue.getJobs(states, 0, Math.max(0, limit - 1), false);
    return Promise.all(
      jobs.map(async (job) => ({
        id: job.id ?? '',
        name: job.name,
        state: await job.getState(),
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? null,
        timestamp: job.timestamp ?? null,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
        failedReason: job.failedReason ?? null,
      })),
    );
  }

  /**
   * Creates a worker for a queue with the queue's configured concurrency.
   * Returns null when queues are disabled.
   */
  createWorker<T>(
    name: QueueName,
    processor: (job: Job<T>) => Promise<unknown>,
  ): Worker<T> | null {
    if (!this.enabled) return null;

    const connection = this.createConnection(`[queue:${name}] `);

    const worker = new Worker<T>(name, processor, {
      connection,
      prefix: this.prefix,
      concurrency: this.policies[name].concurrency,
    });
    this.workers.push(worker);

    worker.on('completed', (job) => this.recordOutcome(name, job, 'completed'));
    worker.on('failed', (job, err) => {
      this.recordOutcome(name, job, 'failed');
      this.logger.warn(
        `[queue:${name}] job ${job?.id ?? 'unknown'} failed: ${err.message}`,
      );
    });
    worker.on('error', (err) =>
      this.logger.error(`[queue:${name}] worker error: ${err.message}`),
    );

    this.logger.log(
      `[queue:${name}] worker started (concurrency ${this.policies[name].concurrency}, attempts ${this.policies[name].attempts})`,
    );
    return worker;
  }

  private recordOutcome(
    name: QueueName,
    job: Job | undefined,
    result: 'completed' | 'failed',
  ): void {
    const durationSeconds =
      job?.processedOn && job?.finishedOn
        ? (job.finishedOn - job.processedOn) / 1_000
        : 0;
    this.metrics?.recordQueueJob(name, result, durationSeconds);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.workers.map((worker) =>
        worker
          .close()
          .catch((err) =>
            this.logger.warn(`Failed to close worker: ${err.message}`),
          ),
      ),
    );
    await Promise.all(
      [...this.queues.values()].map((queue) =>
        queue
          .close()
          .catch((err) =>
            this.logger.warn(`Failed to close queue: ${err.message}`),
          ),
      ),
    );
    await Promise.all(
      this.connections.map((connection) =>
        connection
          .quit()
          .catch((err) =>
            this.logger.warn(
              `Failed to close Redis connection: ${err.message}`,
            ),
          ),
      ),
    );
  }
}
