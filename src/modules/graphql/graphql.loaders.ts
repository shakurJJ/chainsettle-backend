import * as DataLoader from 'dataloader';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Per-request DataLoaders — batch child lookups so nested queries like
 * `shipments { milestones { proofSubmissions } }` issue one query per level
 * instead of one per parent (#430).
 */
export interface GqlLoaders {
  milestonesByShipment: DataLoader<string, any[]>;
  proofsByMilestone: DataLoader<string, any[]>;
}

function groupBy<T>(keys: readonly string[], rows: T[], key: (r: T) => string): T[][] {
  const map = new Map<string, T[]>(keys.map((k) => [k, []]));
  for (const row of rows) map.get(key(row))?.push(row);
  return keys.map((k) => map.get(k)!);
}

export function createLoaders(prisma: PrismaService): GqlLoaders {
  return {
    milestonesByShipment: new DataLoader(async (shipmentIds) => {
      const rows = await prisma.milestone.findMany({
        where: { shipmentId: { in: [...shipmentIds] }, deletedAt: null },
        orderBy: { milestoneIndex: 'asc' },
      });
      return groupBy(shipmentIds, rows, (r) => r.shipmentId);
    }),
    proofsByMilestone: new DataLoader(async (milestoneIds) => {
      const rows = await prisma.proofSubmission.findMany({
        where: { milestoneId: { in: [...milestoneIds] } },
        orderBy: { createdAt: 'asc' },
      });
      return groupBy(milestoneIds, rows, (r) => r.milestoneId);
    }),
  };
}
