import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import {
  exportResultKey,
  QUEUE_EXPORTS,
  ShipmentsExportJobData,
  ShipmentsExportResult,
} from '../../common/queue/queue.constants';
import { QueueService } from '../../common/queue/queue.service';
import { RedisService } from '../../common/redis/redis.service';
import { ShipmentsService } from './shipments.service';

/** Default lifetime of a finished export in Redis (1 hour). */
const DEFAULT_EXPORT_TTL_MS = 60 * 60 * 1_000;

/**
 * Worker for the `exports` queue (#661). Builds the CSV/PDF off the request
 * path and stores the result in Redis keyed by job id, so the caller can poll
 * job status and then download it.
 */
@Injectable()
export class ShipmentsExportProcessor implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly shipments: ShipmentsService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.queue.createWorker<ShipmentsExportJobData>(QUEUE_EXPORTS, (job) =>
      this.process(job),
    );
  }

  async process(
    job: Job<ShipmentsExportJobData>,
  ): Promise<ShipmentsExportResult> {
    const { stellarAddress, isAdmin, format } = job.data;
    const shipments = await this.shipments.exportForUser(
      stellarAddress,
      isAdmin,
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `chainsettle-export-${timestamp}.${format}`;
    const body =
      format === 'pdf'
        ? await this.shipments.buildPdf(shipments)
        : Buffer.from(this.shipments.buildCsv(shipments), 'utf8');

    const ttlMs = this.exportTtlMs();
    await this.redis.setPx(
      exportResultKey(job.id!),
      body.toString('base64'),
      ttlMs,
    );

    return {
      format,
      filename,
      contentType: format === 'pdf' ? 'application/pdf' : 'text/csv',
      sizeBytes: body.length,
    };
  }

  private exportTtlMs(): number {
    const raw = this.config.get<string | number>(
      'EXPORT_RESULT_TTL_MS',
      DEFAULT_EXPORT_TTL_MS,
    );
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_EXPORT_TTL_MS;
  }
}
