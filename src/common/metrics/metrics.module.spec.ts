import { Gauge, Registry } from 'prom-client';
import { ShipmentStatus } from '@prisma/client';
import { collectShipmentsByStatus } from './metrics.module';
import { SHIPMENTS_BY_STATUS_GAUGE } from './metrics.service';

describe('collectShipmentsByStatus (#305)', () => {
  let registry: Registry;
  let prisma: { shipment: { groupBy: jest.Mock } };

  beforeEach(() => {
    registry = new Registry();
    prisma = { shipment: { groupBy: jest.fn() } };
    new Gauge({
      name: SHIPMENTS_BY_STATUS_GAUGE,
      help: 'test',
      labelNames: ['status'],
      registers: [registry],
      collect() {
        return collectShipmentsByStatus.call(this, prisma);
      },
    });
  });

  const values = async () => {
    const metric = await registry.getSingleMetric(SHIPMENTS_BY_STATUS_GAUGE)!.get();
    return Object.fromEntries(metric.values.map((v) => [v.labels.status, v.value]));
  };

  it('exposes one series per shipment status from a single grouped query', async () => {
    prisma.shipment.groupBy.mockResolvedValue([
      { status: ShipmentStatus.ACTIVE, _count: { _all: 4 } },
      { status: ShipmentStatus.COMPLETED, _count: { _all: 2 } },
    ]);

    const result = await values();

    expect(prisma.shipment.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.shipment.groupBy).toHaveBeenCalledWith({ by: ['status'], _count: { _all: true } });
    expect(Object.keys(result).sort()).toEqual(Object.values(ShipmentStatus).sort());
    expect(result).toMatchObject({ ACTIVE: 4, COMPLETED: 2, CANCELLED: 0 });
  });

  it('reflects status changes on the next scrape', async () => {
    prisma.shipment.groupBy.mockResolvedValueOnce([{ status: ShipmentStatus.ACTIVE, _count: { _all: 3 } }]);
    expect(await values()).toMatchObject({ ACTIVE: 3, CANCELLED: 0 });

    prisma.shipment.groupBy.mockResolvedValueOnce([
      { status: ShipmentStatus.ACTIVE, _count: { _all: 2 } },
      { status: ShipmentStatus.CANCELLED, _count: { _all: 1 } },
    ]);
    expect(await values()).toMatchObject({ ACTIVE: 2, CANCELLED: 1 });
  });

  it('keeps the previous values when the query fails', async () => {
    prisma.shipment.groupBy.mockResolvedValueOnce([{ status: ShipmentStatus.ACTIVE, _count: { _all: 5 } }]);
    await values();

    prisma.shipment.groupBy.mockRejectedValueOnce(new Error('db down'));
    expect(await values()).toMatchObject({ ACTIVE: 5 });
  });
});
