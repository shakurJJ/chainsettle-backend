import { Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { MetricsService } from "../metrics/metrics.service";

export interface JobRunRecord {
  name: string;
  lastRunAt: string;
  lastResult: "SUCCESS" | "FAILURE";
  durationMs: number;
  error?: string | null;
}

export const getJobRedisKey = (jobName: string) =>
  `chainsettle:jobs:${jobName}:last_run`;

/**
 * Result type for runTrackedJobWithMetrics - includes metrics recording.
 */
export interface JobResult<T> {
  result: T;
  skipped?: boolean;
}

/**
 * Shared job execution wrapper that tracks execution timestamp, duration,
 * and result (SUCCESS/FAILURE) in Redis (#533).
 * 
 * @param redis - Redis service for job tracking
 * @param jobName - Name of the job for identification
 * @param fn - Async function to execute
 * @param logger - Optional logger for error reporting
 * @param metrics - Optional metrics service for Prometheus metrics
 * @returns The result of the job function
 */
export async function runTrackedJob<T>(
  redis: RedisService,
  jobName: string,
  fn: () => Promise<T>,
  logger?: Logger,
  metrics?: MetricsService,
): Promise<T> {
  const start = Date.now();
  const lastRunAt = new Date().toISOString();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    
    // Record metrics if provided
    metrics?.recordJobRun(jobName, durationMs, 'success');
    
    await redis
      .setJson(getJobRedisKey(jobName), {
        name: jobName,
        lastRunAt,
        lastResult: "SUCCESS",
        durationMs,
        error: null,
      })
      .catch((err) => {
        logger?.warn(
          `Failed to record job success in Redis for ${jobName}: ${err.message}`,
        );
      });
    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Record failure metrics
    metrics?.recordJobRun(jobName, durationMs, 'failure');
    
    await redis
      .setJson(getJobRedisKey(jobName), {
        name: jobName,
        lastRunAt,
        lastResult: "FAILURE",
        durationMs,
        error: errorMessage,
      })
      .catch((err) => {
        logger?.warn(
          `Failed to record job failure in Redis for ${jobName}: ${err.message}`,
        );
      });
    throw error;
  }
}

/**
 * Records a skipped job execution (when lock is not acquired).
 * Used when a job is scheduled but cannot run because another instance holds the lock.
 * 
 * @param jobName - Name of the job that was skipped
 * @param metrics - Metrics service for Prometheus metrics
 * @param redis - Redis service for job tracking (optional)
 * @param logger - Optional logger
 */
export async function recordJobSkipped(
  jobName: string,
  metrics: MetricsService,
  redis?: RedisService,
  logger?: Logger,
): Promise<void> {
  const start = Date.now();
  const lastRunAt = new Date().toISOString();
  
  // Record skipped metric (0 duration since it didn't actually run)
  metrics.recordJobRun(jobName, 0, 'skipped');
  
  // Optionally record in Redis for job tracking
  if (redis) {
    await redis
      .setJson(getJobRedisKey(jobName), {
        name: jobName,
        lastRunAt,
        lastResult: "SKIPPED",
        durationMs: 0,
        error: "Lock not acquired",
      })
      .catch((err) => {
        logger?.warn(
          `Failed to record job skipped in Redis for ${jobName}: ${err.message}`,
        );
      });
  }
}
