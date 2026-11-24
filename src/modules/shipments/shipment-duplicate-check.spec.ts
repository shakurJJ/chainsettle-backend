import { ShipmentStatus } from '@prisma/client';
import { ShipmentsService } from './shipments.service';

describe('ShipmentsService.findPossibleDuplicates (#388)', () => {
  let prisma: any;
  let service: ShipmentsService;
  const body = {
    supplierAddress: 'GSUP',
    tokenAddress: 'CTOKEN',
    totalAmount: '1000',
    referenceNumber: 'PO-1',
  };

  beforeEach(() => {
    prisma = { shipment: { findMany: jest.fn().mockResolvedValue([]) } };
    service = Object.create(ShipmentsService.prototype);
    Object.assign(service, { prisma });
  });

  it('only queries the caller\'s ACTIVE shipments and has no side effects', async () => {
    await service.findPossibleDuplicates('GBUYER', body);
    const { where } = prisma.shipment.findMany.mock.calls[0][0];
    expect(where.buyerAddress).toBe('GBUYER');
    expect(where.status).toBe(ShipmentStatus.ACTIVE);
    expect(Object.keys(prisma.shipment)).toEqual(['findMany']);
  });

  it('matches on supplier + token + amount within 7 days', async () => {
    prisma.shipment.findMany.mockResolvedValue([
      { id: 's1', createdAt: new Date(), referenceNumber: null, supplierAddress: 'GSUP', tokenAddress: 'CTOKEN', totalAmount: 1000n },
    ]);
    const { possibleDuplicates } = await service.findPossibleDuplicates('GBUYER', { ...body, referenceNumber: undefined });
    expect(possibleDuplicates).toEqual([
      expect.objectContaining({ id: 's1', matchReasons: ['SAME_SUPPLIER_TOKEN_AMOUNT_WITHIN_7_DAYS'] }),
    ]);
    const { where } = prisma.shipment.findMany.mock.calls[0][0];
    expect(where.OR[0].totalAmount).toBe(1000n);
    expect(where.OR[0].createdAt.gte.getTime()).toBeLessThanOrEqual(Date.now() - 7 * 24 * 3600 * 1000 + 1000);
  });

  it('matches on referenceNumber regardless of age', async () => {
    prisma.shipment.findMany.mockResolvedValue([
      { id: 's2', createdAt: new Date('2020-01-01'), referenceNumber: 'PO-1', supplierAddress: 'GOTHER', tokenAddress: 'CTOKEN', totalAmount: 5n },
    ]);
    const { possibleDuplicates } = await service.findPossibleDuplicates('GBUYER', body);
    expect(possibleDuplicates[0].matchReasons).toEqual(['SAME_REFERENCE_NUMBER']);
  });

  it('reports both reasons when both rules match', async () => {
    prisma.shipment.findMany.mockResolvedValue([
      { id: 's3', createdAt: new Date(), referenceNumber: 'PO-1', supplierAddress: 'GSUP', tokenAddress: 'CTOKEN', totalAmount: 1000n },
    ]);
    const { possibleDuplicates } = await service.findPossibleDuplicates('GBUYER', body);
    expect(possibleDuplicates[0].matchReasons).toEqual([
      'SAME_SUPPLIER_TOKEN_AMOUNT_WITHIN_7_DAYS',
      'SAME_REFERENCE_NUMBER',
    ]);
  });

  it('returns an empty list when nothing matches', async () => {
    await expect(service.findPossibleDuplicates('GBUYER', body)).resolves.toEqual({ possibleDuplicates: [] });
  });
});
