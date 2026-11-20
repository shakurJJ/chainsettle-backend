import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';

/**
 * Backfill script for audit log hash chaining (issue #664).
 *
 * Walks existing audit log rows in insertion order and populates the
 * `prevHash` and `hash` columns so that the chain is verifiable by
 * GET /admin/audit-logs/verify.
 *
 * Usage: ts-node scripts/backfill-audit-log-hashes.ts
 */

const prisma = new PrismaClient();

interface AuditLogRow {
  id: string;
  action: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: Date;
  prevHash: string | null;
  hash: string | null;
}

function computeHash(row: AuditLogRow, prevHash: string | null): string {
  const payload = JSON.stringify({
    id: row.id,
    action: row.action,
    actorId: row.actorId,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt.toISOString(),
    prevHash,
  });
  return createHash('sha256').update(payload).digest('hex');
}

async function main(): Promise<void> {
  const rows = (await prisma.auditLog.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })) as unknown as AuditLogRow[];

  let prevHash: string | null = null;
  let updated = 0;

  for (const row of rows) {
    const hash = computeHash(row, prevHash);
    if (row.prevHash !== prevHash || row.hash !== hash) {
      await prisma.auditLog.update({
        where: { id: row.id },
        data: { prevHash, hash },
      });
      updated += 1;
    }
    prevHash = hash;
  }

  console.log(`Backfilled ${updated} of ${rows.length} audit log rows.`);
}

main()
  .catch((err) => {
    console.error('Audit log hash backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
