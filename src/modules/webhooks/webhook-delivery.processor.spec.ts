import { Job } from 'bullmq';
import { QueueService } from '../../common/queue/queue.service';
import { QUEUE_WEBHOOKS } from '../../common/queue/queue.constants';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhooksService } from './webhooks.service';

describe('WebhookDeliveryProcessor (#661)', () => {
  let queue: { createWorker: jest.Mock };
  let webhooks: { processQueuedDelivery: jest.Mock };
  let processor: WebhookDeliveryProcessor;

  const job = {
    id: 'job-1',
    data: { deliveryId: 'del-1' },
    opts: { attempts: 5 },
  } as unknown as Job<{ deliveryId: string }>;

  beforeEach(() => {
    queue = { createWorker: jest.fn() };
    webhooks = { processQueuedDelivery: jest.fn() };
    processor = new WebhookDeliveryProcessor(
      queue as unknown as QueueService,
      webhooks as unknown as WebhooksService,
    );
  });

  it('registers a worker for the webhooks queue', () => {
    processor.onModuleInit();

    expect(queue.createWorker).toHaveBeenCalledWith(
      QUEUE_WEBHOOKS,
      expect.any(Function),
    );
  });

  it('throws on a retryable failure so BullMQ retries with back-off', async () => {
    webhooks.processQueuedDelivery.mockResolvedValue({ retryable: true });

    await expect(processor.process(job)).rejects.toThrow(
      /BullMQ will retry/,
    );
    expect(webhooks.processQueuedDelivery).toHaveBeenCalledWith('del-1', 5);
  });

  it('completes without throwing when the failure is permanent', async () => {
    webhooks.processQueuedDelivery.mockResolvedValue({ retryable: false });

    await expect(processor.process(job)).resolves.toBeUndefined();
  });
});
