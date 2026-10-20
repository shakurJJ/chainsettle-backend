import { Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

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
 * Shared job execution wrapper that tracks execution timestamp, duration,
 * and result (SUCCESS/FAILURE) in Redis (#533).
 */
export async function runTrackedJob<T>(
  redis: RedisService,
  jobName: string,
  fn: () => Promise<T>,
  logger?: Logger,
): Promise<T> {
  const start = Date.now();
  const lastRunAt = new Date().toISOString();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
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
