import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

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
 *
 * `userIds` and `orgIds` are explicit targeting lists. A subject (or its
 * organization) that appears in either list is always on when `enabled` is
 * true, regardless of the rollout percentage.
 */
export interface FeatureFlag {
  enabled: boolean;
  rollout?: number;
  userIds?: string[];
  orgIds?: string[];
}

/** A flag plus the name it is stored under. */
export interface NamedFeatureFlag extends FeatureFlag {
  name: string;
}

/**
 * Database-backed feature flag store with a Redis read cache.
 *
 * Flags are persisted in the database (source of truth) and cached in Redis.
 * Every write updates the database and invalidates the Redis cache key, so a
 * toggle takes effect on the very next request, across every pod, without a
 * redeploy or restart.
 *
 * Unknown flags evaluate to false. New functionality is therefore off until
 * somebody explicitly turns it on, which is the safe default for both a
 * gradual rollout and a kill switch.
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

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

  /** Normalise a raw stored record into a FeatureFlag. */
  private normalise(stored: {
    enabled: boolean;
    rollout?: number | null;
    userIds?: string[] | null;
    orgIds?: string[] | null;
  }): FeatureFlag {
    const flag: FeatureFlag = { enabled: stored.enabled };
    if (typeof stored.rollout === 'number') {
      flag.rollout = Math.min(100, Math.max(0, stored.rollout));
    }
    if (Array.isArray(stored.userIds) && stored.userIds.length > 0) {
      flag.userIds = [...stored.userIds];
    }
    if (Array.isArray(stored.orgIds) && stored.orgIds.length > 0) {
      flag.orgIds = [...stored.orgIds];
    }
    return flag;
  }

  /**
   * Read a flag's raw configuration, or null when it has never been set.
   *
   * Checks the Redis cache first; on a miss, reads from the database and
   * populates the cache. Unknown flags are not cached so that a flag created
   * later is picked up immediately.
   */
  async getFlag(name: string): Promise<FeatureFlag | null> {
    const cached = await this.redis.getJson<FeatureFlag>(this.key(name));
    if (cached && typeof cached.enabled === 'boolean') {
      return this.normalise(cached);
    }

    const record = await this.prisma.featureFlag.findUnique({
      where: { key: name },
    });
    if (!record) return null;

    const flag = this.normalise(record);
    await this.redis.set(this.key(name), JSON.stringify(flag));
    return flag;
  }

  /**
   * Decide whether a flag is on for a given subject.
   *
   * Evaluation order:
   * 1. Unknown flag or master switch off -> false.
   * 2. Explicit targeting: subject or its org listed -> true.
   * 3. Percentage rollout bucketing.
   *
   * @param name      Flag name, e.g. "shipment-templates".
   * @param subjectId Stable identifier for the caller (user id or Stellar
   *   address). Percentage rollouts need one to bucket against; a percentage
   *   flag with no subject evaluates to false rather than flapping between
   *   requests.
   * @param orgId     Optional organization the caller belongs to, used for
   *   explicit org targeting.
   */
  async isEnabled(
    name: string,
    subjectId?: string,
    orgId?: string,
  ): Promise<boolean> {
    const flag = await this.getFlag(name);

    // Unknown flag: off. Fail closed.
    if (!flag) return false;

    // Master switch wins over any targeting or rollout percentage.
    if (!flag.enabled) return false;

    // Explicit targeting: a listed subject or org is always on.
    if (subjectId && flag.userIds?.includes(subjectId)) return true;
    if (orgId && flag.orgIds?.includes(orgId)) return true;

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
   * Persists to the database, invalidates the Redis cache key and records an
   * audit log entry.
   */
  async setFlag(
    name: string,
    flag: FeatureFlag,
    actorId?: string,
  ): Promise<FeatureFlag> {
    const payload = this.normalise(flag);

    await this.prisma.featureFlag.upsert({
      where: { key: name },
      create: {
        key: name,
        enabled: payload.enabled,
        rollout: payload.rollout ?? null,
        userIds: payload.userIds ?? [],
        orgIds: payload.orgIds ?? [],
      },
      update: {
        enabled: payload.enabled,
        rollout: payload.rollout ?? null,
        userIds: payload.userIds ?? [],
        orgIds: payload.orgIds ?? [],
      },
    });

    await this.invalidate(name);
    await this.recordAudit('feature-flag.updated', name, actorId, payload);

    this.logger.log(
      `Feature flag "${name}" set to enabled=${payload.enabled}` +
        (payload.rollout !== undefined ? ` rollout=${payload.rollout}%` : '') +
        (payload.userIds ? ` users=${payload.userIds.length}` : '') +
        (payload.orgIds ? ` orgs=${payload.orgIds.length}` : ''),
    );
    return payload;
  }

  /** Alias for {@link setFlag}, used by the admin PATCH endpoint. */
  async updateFlag(
    name: string,
    flag: FeatureFlag,
    actorId?: string,
  ): Promise<FeatureFlag> {
    return this.setFlag(name, flag, actorId);
  }

  /** Remove a flag entirely. It then evaluates as off, like any unknown flag. */
  async deleteFlag(name: string, actorId?: string): Promise<void> {
    await this.prisma.featureFlag.deleteMany({ where: { key: name } });
    await this.invalidate(name);
    await this.recordAudit('feature-flag.deleted', name, actorId, null);
    this.logger.log(`Feature flag "${name}" deleted`);
  }

  /** Drop the cached copy of a flag so the next read hits the database. */
  private async invalidate(name: string): Promise<void> {
    await this.redis.del(this.key(name));
  }

  /** Best-effort audit trail; a logging failure must not fail the write. */
  private async recordAudit(
    action: string,
    name: string,
    actorId: string | undefined,
    payload: FeatureFlag | null,
  ): Promise<void> {
    try {
      await this.auditLog.log({
        action,
        actorId,
        resource: 'feature-flag',
        resourceId: name,
        metadata: payload ? { ...payload } : undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to audit ${action} for feature flag "${name}": ${
          (err as Error).message
        }`,
      );
    }
  }

  /** List every configured flag, read from the database. */
  async listFlags(): Promise<NamedFeatureFlag[]> {
    const records = await this.prisma.featureFlag.findMany({
      orderBy: { key: 'asc' },
    });

    return records.map((record) => ({
      name: record.key,
      ...this.normalise(record),
    }));
  }
}
