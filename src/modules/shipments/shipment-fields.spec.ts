import { BadRequestException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import {
  parseFields,
  pickFields,
  SHIPMENT_DETAIL_FIELDS,
  SHIPMENT_LIST_FIELDS,
} from './shipment-fields';

describe('Sparse fieldsets (#390)', () => {
  describe('parseFields', () => {
    it('returns undefined when absent or empty (full response)', () => {
      expect(parseFields(undefined, SHIPMENT_LIST_FIELDS)).toBeUndefined();
      expect(parseFields(' , ', SHIPMENT_LIST_FIELDS)).toBeUndefined();
    });

    it('always includes id, de-duplicates and sorts', () => {
      expect(parseFields('status, totalAmount,status', SHIPMENT_LIST_FIELDS)).toEqual([
        'id',
        'status',
        'totalAmount',
      ]);
    });

    it('rejects unknown fields with 400 listing valid options', () => {
      try {
        parseFields('status,password,foo', SHIPMENT_LIST_FIELDS);
        fail('expected BadRequestException');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const body = (err as BadRequestException).getResponse() as any;
        expect(body.invalidFields).toEqual(['password', 'foo']);
        expect(body.validFields).toEqual(SHIPMENT_LIST_FIELDS);
      }
    });

    it('only allows detail relations on the detail endpoint', () => {
      expect(() => parseFields('events', SHIPMENT_LIST_FIELDS)).toThrow(BadRequestException);
      expect(parseFields('events', SHIPMENT_DETAIL_FIELDS)).toEqual(['events', 'id']);
    });
  });

  it('pickFields keeps only requested keys', () => {
    expect(pickFields({ id: '1', status: 'ACTIVE', tags: [] }, ['id', 'status'])).toEqual({
      id: '1',
      status: 'ACTIVE',
    });
  });

  describe('ShipmentsService', () => {
    let service: ShipmentsService;
    let db: any;
    let redis: any;

    const row = {
      id: 'SHIP-1',
      status: 'ACTIVE',
      totalAmount: 1_000_000_000n,
      tokenDecimals: 7,
      tokenSymbol: 'USDC',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };

    beforeEach(() => {
      db = {
        shipment: {
          findMany: jest.fn().mockResolvedValue([row]),
          count: jest.fn().mockResolvedValue(1),
          findUnique: jest.fn().mockResolvedValue(row),
        },
        $transaction: jest.fn((ops: Promise<any>[]) => Promise.all(ops)),
      };
      const store = new Map<string, string>();
      redis = {
        getJson: jest.fn(async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null)),
        setJson: jest.fn(async (k: string, v: unknown) => {
          store.set(k, JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
        }),
      };
      const prisma: any = { read: db };
      const stellar: any = { toHumanAmount: () => '100.0000000' };
      const config: any = { get: (_k: string, d: any) => d };
      const fxRate: any = { getUsdRate: jest.fn().mockResolvedValue(null) };
      service = new ShipmentsService(
        prisma, stellar, {} as any, {} as any, redis, config, {} as any, {} as any, {} as any, {} as any, fxRate,
      );
    });

    it('list: pushes the selection into Prisma select and returns only requested fields + id', async () => {
      const result = await service.findAll({ fields: ['id', 'status', 'totalAmount'] });

      const args = db.shipment.findMany.mock.calls[0][0];
      expect(args.include).toBeUndefined();
      expect(args.select).toMatchObject({ id: true, status: true, totalAmount: true });
      expect(args.select.milestones).toBeUndefined();
      expect(result.data[0]).toEqual({ id: 'SHIP-1', status: 'ACTIVE', totalAmount: '1000000000' });
    });

    it('list: selecting milestones keeps the soft-delete filter', async () => {
      await service.findAll({ fields: ['id', 'milestones'] });
      const args = db.shipment.findMany.mock.calls[0][0];
      expect(args.select.milestones).toEqual({
        where: { deletedAt: null },
        orderBy: { milestoneIndex: 'asc' },
      });
    });

    it('list: without fields the full include is used', async () => {
      await service.findAll({});
      const args = db.shipment.findMany.mock.calls[0][0];
      expect(args.select).toBeUndefined();
      expect(args.include.milestones).toBeDefined();
    });

    it('detail: returns only requested fields + id', async () => {
      const result = await service.findOne('SHIP-1', undefined, undefined, ['id', 'status']);
      const args = db.shipment.findUnique.mock.calls[0][0];
      expect(args.select).toMatchObject({ id: true, status: true });
      expect(args.include).toBeUndefined();
      expect(result).toEqual({ id: 'SHIP-1', status: 'ACTIVE' });
    });

    it('cache: different field sets never share an entry', async () => {
      const caller = 'G' + 'A'.repeat(55);
      await service.findAllCached({ callerStellarAddress: caller, fields: ['id', 'status'] });
      await service.findAllCached({ callerStellarAddress: caller, fields: ['id', 'totalAmount'] });

      const keys = redis.setJson.mock.calls.map((c: any[]) => c[0]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toEqual(keys[1]);
      expect(db.shipment.findMany).toHaveBeenCalledTimes(2);

      // Same field set again is served from cache.
      const cached = await service.findAllCached({ callerStellarAddress: caller, fields: ['id', 'status'] });
      expect(db.shipment.findMany).toHaveBeenCalledTimes(2);
      expect(cached.data[0]).toEqual({ id: 'SHIP-1', status: 'ACTIVE' });
    });
  });
});
