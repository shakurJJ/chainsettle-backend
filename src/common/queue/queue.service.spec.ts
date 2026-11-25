import { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';
import { QueueService } from './queue.service';

function disabledConfig(): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      key === 'QUEUE_ENABLED' ? 'false' : fallback,
  } as unknown as ConfigService;
}

describe('QueueService (#661)', () => {
  let queues: QueueService;

  beforeEach(() => {
    queues = new QueueService(disabledConfig());
  });

  afterAll(async () => {
    await queues.onModuleDestroy();
  });

  it('creates no Redis connection when QUEUE_ENABLED=false', () => {
    expect(queues.isEnabled()).toBe(false);
  });

  it('reports zero depth for every queue so /metrics still has the series', async () => {
    const stats = await queues.getStats();

    expect(stats.map((s) => s.name)).toEqual([...QUEUE_NAMES]);
    for (const stat of stats) {
      expect(stat.counts).toEqual({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
      });
    }
  });

  it('exposes the resolved policy for each queue', () => {
    expect(queues.getPolicy('webhooks').attempts).toBe(5);
    expect(queues.getPolicy('exports').concurrency).toBe(2);
  });

  it('does not enqueue jobs or create workers when disabled', async () => {
    await expect(
      queues.add('webhooks', 'webhook-delivery', { deliveryId: 'd1' }),
    ).resolves.toBeNull();
    expect(queues.createWorker('webhooks', async () => undefined)).toBeNull();
  });
});
