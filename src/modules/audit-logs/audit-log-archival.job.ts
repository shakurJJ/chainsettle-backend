import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { JOB_LOCK_KEYS } from '../../common/jobs/job-locks';
import { runTrackedJob } from '../../common/jobs/job-tracker.util';

export const AUDIT_ARCHIVAL_JOB_NAME = 'audit-log-archival';
const LOCK_TTL_MS = 30 * 60 * 1000;
const BATCH_SIZE = 5000;
const MANIFEST = 'manifest.jsonl';
export const ARCHIVE_GENESIS_HASH = '0'.repeat(64);

export interface ArchiveManifestEntry {
  file: string;
  count: number;
  from: string;
  to: string;
  /** Chain hash of the previous archive (genesis for the first). */
  prevHash: string;
  /** sha256(prevHash + every row line) — links archives into one chain. */
  hash: string;
  /** sha256 of the compressed file, to detect tampering/corruption. */
  fileSha256: string;
  archivedAt: string;
}

/**
 * Moves audit_logs rows older than AUDIT_LOG_RETENTION_DAYS to gzip-compressed
 * JSONL files under AUDIT_LOG_ARCHIVE_DIR (mount this on object storage, e.g.
 * an S3/GCS-backed volume), then deletes them from the table.
 *
 * Each archive is appended to manifest.jsonl with a chain hash computed over
 * the previous archive's hash and the archived rows, so the full history stays
 * verifiable across archives (see verifyChain). restore() re-imports a file.
 */
@Injectable()
export class AuditLogArchivalJob implements OnModuleInit {
  private readonly logger = new Logger(AuditLogArchivalJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit() {
    const cronTime = this.config.get<string>('AUDIT_LOG_ARCHIVAL_CRON', '30 3 * * *');
    const job = new CronJob(cronTime, () => this.run());
    this.schedulerRegistry.addCronJob(AUDIT_ARCHIVAL_JOB_NAME, job);
    job.start();
  }

  private get dir(): string {
    return path.resolve(this.config.get<string>('AUDIT_LOG_ARCHIVE_DIR', './archives/audit-logs'));
  }

  async run(): Promise<void> {
    const token = randomUUID();
    const lockKey = JOB_LOCK_KEYS[AUDIT_ARCHIVAL_JOB_NAME];
    if (!(await this.redis.acquireLock(lockKey, token, LOCK_TTL_MS))) {
      this.logger.debug('Skipping audit log archival — lock held elsewhere');
      return;
    }
    try {
      await runTrackedJob(this.redis, AUDIT_ARCHIVAL_JOB_NAME, () => this.archive(), this.logger);
    } catch (err: any) {
      this.logger.error(`Audit log archival failed: ${err.message}`);
    } finally {
      await this.redis.releaseLock(lockKey, token);
    }
  }

  /** Archives every row older than the retention cutoff. Returns rows archived. */
  async archive(): Promise<number> {
    const days = this.config.get<number>('AUDIT_LOG_RETENTION_DAYS', 365);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await fs.mkdir(this.dir, { recursive: true });
    const db = this.prisma.jobs;
    let total = 0;

    for (;;) {
      const rows = await db.auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const lines = rows.map((r) => JSON.stringify(r));
      const prevHash = (await this.lastManifestEntry())?.hash ?? ARCHIVE_GENESIS_HASH;
      const hash = AuditLogArchivalJob.chainHash(prevHash, lines);
      const gz = gzipSync(lines.join('\n') + '\n');
      const from = rows[0].createdAt.toISOString();
      const to = rows[rows.length - 1].createdAt.toISOString();
      const file = `audit-logs-${from.replace(/[:.]/g, '-')}-${hash.slice(0, 12)}.jsonl.gz`;

      // Write the file durably before deleting anything.
      const tmp = path.join(this.dir, `${file}.tmp`);
      await fs.writeFile(tmp, gz);
      await fs.rename(tmp, path.join(this.dir, file));

      const entry: ArchiveManifestEntry = {
        file,
        count: rows.length,
        from,
        to,
        prevHash,
        hash,
        fileSha256: createHash('sha256').update(gz).digest('hex'),
        archivedAt: new Date().toISOString(),
      };
      await fs.appendFile(path.join(this.dir, MANIFEST), JSON.stringify(entry) + '\n');

      await db.auditLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += rows.length;
      this.logger.log(`Archived ${rows.length} audit log rows to ${file}`);
      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  static chainHash(prevHash: string, lines: string[]): string {
    const h = createHash('sha256').update(prevHash);
    for (const line of lines) h.update('\n').update(line);
    return h.digest('hex');
  }

  async readManifest(): Promise<ArchiveManifestEntry[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir, MANIFEST), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  private async lastManifestEntry(): Promise<ArchiveManifestEntry | undefined> {
    const entries = await this.readManifest();
    return entries[entries.length - 1];
  }

  private async readArchiveLines(entry: ArchiveManifestEntry): Promise<string[]> {
    const gz = await fs.readFile(path.join(this.dir, path.basename(entry.file)));
    if (createHash('sha256').update(gz).digest('hex') !== entry.fileSha256) {
      throw new Error(`Archive ${entry.file} checksum mismatch`);
    }
    return gunzipSync(gz).toString('utf8').split('\n').filter(Boolean);
  }

  /** Verifies every archive file and the hash chain linking them. */
  async verifyChain(): Promise<{ valid: boolean; brokenAt?: string; reason?: string }> {
    let expectedPrev = ARCHIVE_GENESIS_HASH;
    for (const entry of await this.readManifest()) {
      if (entry.prevHash !== expectedPrev) {
        return { valid: false, brokenAt: entry.file, reason: 'prevHash does not match previous archive' };
      }
      let lines: string[];
      try {
        lines = await this.readArchiveLines(entry);
      } catch (err: any) {
        return { valid: false, brokenAt: entry.file, reason: err.message };
      }
      if (AuditLogArchivalJob.chainHash(entry.prevHash, lines) !== entry.hash) {
        return { valid: false, brokenAt: entry.file, reason: 'content hash mismatch' };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true };
  }

  /** Re-imports an archive file into audit_logs (skips rows already present). */
  async restore(file: string): Promise<number> {
    const entry = (await this.readManifest()).find((e) => e.file === path.basename(file));
    if (!entry) throw new Error(`Archive ${file} not found in manifest`);
    const rows = (await this.readArchiveLines(entry)).map((l) => {
      const r = JSON.parse(l);
      return { ...r, createdAt: new Date(r.createdAt) };
    });
    const { count } = await this.prisma.jobs.auditLog.createMany({ data: rows, skipDuplicates: true });
    this.logger.log(`Restored ${count} audit log rows from ${entry.file}`);
    return count;
  }
}
