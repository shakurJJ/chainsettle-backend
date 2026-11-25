import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueService } from '../../common/queue/queue.service';
import {
  QUEUE_EMAILS,
  SendEmailJobData,
} from '../../common/queue/queue.constants';
import { NotificationsService } from './notifications.service';

/**
 * Worker for the `emails` queue (#661). SMTP delivery runs here instead of on
 * the request path; a failed send throws so BullMQ retries with back-off.
 */
@Injectable()
export class EmailProcessor implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.queue.createWorker<SendEmailJobData>(QUEUE_EMAILS, (job) =>
      this.process(job),
    );
  }

  async process(job: Job<SendEmailJobData>): Promise<void> {
    await this.notifications.deliverQueuedEmail(job.data);
  }
}
