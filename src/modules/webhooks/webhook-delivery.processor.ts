import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueService } from '../../common/queue/queue.service';
import {
  QUEUE_WEBHOOKS,
  WebhookDeliveryJobData,
} from '../../common/queue/queue.constants';
import { WebhooksService } from './webhooks.service';

/**
 * Worker for the `webhooks` queue (#661). Each job delivers one persisted
 * WebhookDelivery row. Retryable failures rethrow so BullMQ retries with the
 * queue's exponential back-off; non-retryable failures are finalised in the
 * delivery row and the job completes.
 */
@Injectable()
export class WebhookDeliveryProcessor implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly webhooks: WebhooksService,
  ) {}

  onModuleInit(): void {
    this.queue.createWorker<WebhookDeliveryJobData>(QUEUE_WEBHOOKS, (job) =>
      this.process(job),
    );
  }

  async process(job: Job<WebhookDeliveryJobData>): Promise<void> {
    const result = await this.webhooks.processQueuedDelivery(
      job.data.deliveryId,
      job.opts.attempts,
    );

    if (result.retryable) {
      throw new Error(
        `Webhook delivery ${job.data.deliveryId} failed; BullMQ will retry`,
      );
    }
  }
}
