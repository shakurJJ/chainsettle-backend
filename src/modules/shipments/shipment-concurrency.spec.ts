import { PreconditionFailedException } from '@nestjs/common';
import { ShipmentsService, shipmentEtag, ifMatchSatisfied } from './shipments.service';

/**
 * Optimistic concurrency on PATCH /shipments/:id and PUT /shipments/:id/tags (#387).
 * The mock prisma stores one shipment row and honours `updatedAt` in the
 * update `where`, like Postgres would.
 */
describe('Shipment optimistic concurrency (If-Match)', () => {
  let row: any;
  let prisma: any;
  let config: Record<string, string>;
  let service: ShipmentsService;

  beforeEach(() => {
    row = {
      id: 's1',
      buyerAddress: 'GBUYER',
      referenceNumber: null,
      description: 'old',
      tags: [],
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    config = {};
    prisma = {
      shipment: {
        findUnique: jest.fn(async () => ({ ...row })),
        update: jest.fn(async ({ where, data }: any) => {
          if (where.updatedAt && where.updatedAt.getTime() !== row.updatedAt.getTime()) {
            throw Object.assign(new Error('Record not found'), { code: 'P2025' });
          }
          row = { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 1000) };
          return { ...row };
        }),
      },
    };
    prisma.read = prisma;
    prisma.milestone = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.read = prisma;
    prisma.milestone = { findMany: jest.fn().mockResolvedValue([]) };
    service = Object.create(ShipmentsService.prototype);
    Object.assign(service, {
      prisma,
      config: { get: (k: string) => config[k] },
      logger: { log: jest.fn() },
      auditLog: { record: jest.fn() },
      invalidateUserCache: jest.fn(),
      serialize: jest.fn(async (s: any) => s),
    });
  });

  it('accepts a matching If-Match and produces a new ETag', async () => {
    const before = shipmentEtag(row);
    await service.update('s1', 'GBUYER', { description: 'new' }, before);
    const after = await service.getEtag('s1');
    expect(row.description).toBe('new');
    expect(after).not.toBe(before);
  });

  it('rejects a stale If-Match with 412 and changes nothing', async () => {
    const stale = shipmentEtag({ id: 's1', updatedAt: new Date('2025-01-01') });
    await expect(service.update('s1', 'GBUYER', { description: 'new' }, stale)).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
    expect(row.description).toBe('old');
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('keeps today\'s behaviour when no If-Match is sent', async () => {
    await service.update('s1', 'GBUYER', { description: 'new' });
    expect(row.description).toBe('new');
  });

  it('requires If-Match when SHIPMENT_REQUIRE_IF_MATCH=true', async () => {
    config.SHIPMENT_REQUIRE_IF_MATCH = 'true';
    await expect(service.update('s1', 'GBUYER', { description: 'new' })).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
  });

  it('lets only the first of two concurrent edits with the same ETag win', async () => {
    const etag = shipmentEtag(row);
    const results = await Promise.allSettled([
      service.update('s1', 'GBUYER', { description: 'from A' }, etag),
      service.update('s1', 'GBUYER', { description: 'from B' }, etag),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(PreconditionFailedException);
    expect(row.description).toBe('from A');
  });

  it('applies If-Match to PUT /shipments/:id/tags', async () => {
    const stale = shipmentEtag({ id: 's1', updatedAt: new Date('2025-01-01') });
    await expect(service.replaceTags('s1', ['a'], 'GBUYER', 'u1', stale)).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
    await service.replaceTags('s1', ['a'], 'GBUYER', 'u1', shipmentEtag(row));
    expect(row.tags).toEqual(['a']);
  });

  it('matches weak, wildcard and list forms of If-Match', () => {
    const etag = shipmentEtag(row);
    expect(ifMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    expect(ifMatchSatisfied('*', etag)).toBe(true);
    expect(ifMatchSatisfied(`"x", ${etag}`, etag)).toBe(true);
    expect(ifMatchSatisfied('"x"', etag)).toBe(false);
  });

  it('changes the weak detail ETag when a milestone changes', () => {
    const milestoneUpdatedAt = new Date('2026-02-01T00:00:00.000Z');
    expect(shipmentEtag(row, milestoneUpdatedAt)).not.toBe(shipmentEtag(row));
    expect(shipmentEtag(row, milestoneUpdatedAt)).toMatch(/^W\//);
  });
});
