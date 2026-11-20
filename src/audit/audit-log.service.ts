import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { AuditLog } from './audit-log.entity';

const GENESIS_HASH = '0'.repeat(64);

export interface AuditLogVerifyResult {
  valid: boolean;
  checked: number;
  brokenAt?: string;
  reason?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    private readonly dataSource: DataSource,
  ) {}

  private computeHash(entry: Pick<AuditLog, 'action' | 'actorId' | 'targetId' | 'metadata' | 'createdAt'>, prevHash: string): string {
    const payload = JSON.stringify({
      action: entry.action,
      actorId: entry.actorId ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
      createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
      prevHash,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  async record(entry: Partial<AuditLog>): Promise<AuditLog> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AuditLog);

      // Serialize inserts so concurrent writers cannot fork the chain.
      const last = await repo
        .createQueryBuilder('log')
        .setLock('pessimistic_write')
        .orderBy('log.createdAt', 'DESC')
        .addOrderBy('log.id', 'DESC')
        .getOne();

      const prevHash = last?.hash ?? GENESIS_HASH;
      const createdAt = entry.createdAt ?? new Date();
      const hash = this.computeHash(
        {
          action: entry.action as string,
          actorId: entry.actorId,
          targetId: entry.targetId,
          metadata: entry.metadata,
          createdAt,
        },
        prevHash,
      );

      const log = repo.create({ ...entry, createdAt, prevHash, hash });
      return repo.save(log);
    });
  }

  async verifyChain(): Promise<AuditLogVerifyResult> {
    const logs = await this.auditLogRepository.find({
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    let expectedPrev = GENESIS_HASH;
    for (const log of logs) {
      if (log.prevHash !== expectedPrev) {
        return {
          valid: false,
          checked: logs.indexOf(log),
          brokenAt: log.id,
          reason: 'prevHash does not match previous entry hash',
        };
      }
      const recomputed = this.computeHash(log, log.prevHash);
      if (recomputed !== log.hash) {
        return {
          valid: false,
          checked: logs.indexOf(log),
          brokenAt: log.id,
          reason: 'hash does not match entry content',
        };
      }
      expectedPrev = log.hash;
    }

    return { valid: true, checked: logs.length };
  }
}
