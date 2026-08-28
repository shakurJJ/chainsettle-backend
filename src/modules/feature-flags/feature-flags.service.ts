import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';

/** Redis key prefix for every stored flag. */
export const FEATURE_FLAG_PREFIX = 'feature-flag:';

/**
 * Stored shape of a single flag.
 *
 * `enabled` is the master switch: false is an unconditional kill switch,
 * regardless of `rollout`.
 *
 * `rollout` is an optional percentage (0-100). When present and below 100 the
 * flag is on for only that share of subjects, chosen by a stable hash so a
 * given subject always lands in the same bucket.
 */
export interface FeatureFlag {
  enabled: boolean;
  rollout?: number;
}

/** A flag plus the name it is stored under. */
export interface NamedFeatureFlag extends FeatureFlag {
  name: string;
}

/**
 * Redis-backed feature flag store.
 *
 * Flags are read from Redis on every check, with no in-process cache. That is
 * deliberate: toggling a flag with a plain `SET` takes effect on the very next
 * request, across every pod, without a redeploy or restart.
 *
 * Unknown flags evaluate to false. New functionality is therefore off until
 * somebody explicitly turns it on, which is the safe default for both a
 * gradual rollout and a kill switch.
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);

  constructor(private readonly redis: RedisService) {}

  /** Full Redis key for a flag name. */
  private key(name: string): string {
    return `${FEATURE_FLAG_PREFIX}${name}`;
  }

  /**
   * Deterministically bucket a subject into 0-99 for a given flag.
   *
   * The flag name is part of the hash so that a subject who happens to fall in
   * the first 10% of one flag is not automatically in the first 10% of every
   * other flag.
   */
  private bucket(name: string, subjectId: string): number {
    const digest = createHash('sha256').update(`${name}:${subjectId}`).digest();
    return digest.readUInt32BE(0) % 100;
  }

  /**
   * Read a flag's raw configuration, or null when it has never been set.
   */
  async getFlag(name: string): Promise<FeatureFlag | null> {
    const stored = await this.redis.getJson<FeatureFlag>(this.key(name));
    if (!stored || typeof stored.enabled !== 'boolean') return null;

    const flag: FeatureFlag = { enabled: stored.enabled };
    if (typeof stored.rollout === 'number') {
      flag.rollout = Math.min(100, Math.max(0, stored.rollout));
    }
    return flag;
  }

  /**
   * Decide whether a flag is on for a given subject.
   *
   * @param name      Flag name, e.g. "shipment-templates".
   * @param subjectId Stable identifier for the caller (user id or Stellar
   *   address). Percentage rollouts need one to bucket against; a percentage
   *   flag with no subject evaluates to false rather than flapping between
   *   requests.
   */
  async isEnabled(name: string, subjectId?: string): Promise<boolean> {
    const flag = await this.getFlag(name);

    // Unknown flag: off. Fail closed.
    if (!flag) return false;

    // Master switch wins over any rollout percentage.
    if (!flag.enabled) return false;

    // No rollout configured, or fully rolled out.
    if (flag.rollout === undefined || flag.rollout >= 100) return true;

    if (flag.rollout <= 0) return false;

    // A percentage rollout is meaningless without something stable to bucket.
    if (!subjectId) return false;

    return this.bucket(name, subjectId) < flag.rollout;
  }

  /**
   * Create or overwrite a flag.
   *
   * Writes have no TTL: a flag stays as set until it is changed or deleted.
   */
  async setFlag(name: string, flag: FeatureFlag): Promise<FeatureFlag> {
    const payload: FeatureFlag = { enabled: flag.enabled };
    if (typeof flag.rollout === 'number') {
      payload.rollout = Math.min(100, Math.max(0, flag.rollout));
    }

    await this.redis.set(this.key(name), JSON.stringify(payload));
    this.logger.log(
      `Feature flag "${name}" set to enabled=${payload.enabled}` +
        (payload.rollout !== undefined ? ` rollout=${payload.rollout}%` : ''),
    );
    return payload;
  }

  /** Remove a flag entirely. It then evaluates as off, like any unknown flag. */
  async deleteFlag(name: string): Promise<void> {
    await this.redis.del(this.key(name));
    this.logger.log(`Feature flag "${name}" deleted`);
  }

  /**
   * List every configured flag.
   *
   * Uses SCAN under the hood rather than KEYS, so it stays safe on a large
   * shared keyspace.
   */
  async listFlags(): Promise<NamedFeatureFlag[]> {
    const client = this.redis.getClient();
    const names: string[] = [];

    let cursor = '0';
    do {
      const [next, keys] = await client.scan(
        cursor,
        'MATCH',
        `${FEATURE_FLAG_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = next;
      names.push(...keys);
    } while (cursor !== '0');

    const flags: NamedFeatureFlag[] = [];
    for (const key of names.sort()) {
      const name = key.slice(FEATURE_FLAG_PREFIX.length);
      const flag = await this.getFlag(name);
      if (flag) flags.push({ name, ...flag });
    }
    return flags;
  }
}
