import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QueueService } from '../../common/queue/queue.service';
import {
  exportResultKey,
  QUEUE_EXPORTS,
  ShipmentsExportJobData,
} from '../../common/queue/queue.constants';
import { RedisService } from '../../common/redis/redis.service';
import { ShipmentsService } from './shipments.service';
import { ShipmentsExportProcessor } from './shipments-export.processor';

describe('ShipmentsExportProcessor (#661)', () => {
  let queue: { createWorker: jest.Mock };
  let shipments: {
    exportForUser: jest.Mock;
    buildCsv: jest.Mock;
    buildPdf: jest.Mock;
  };
  let redis: { setPx: jest.Mock };
  let processor: ShipmentsExportProcessor;

  beforeEach(() => {
    queue = { createWorker: jest.fn() };
    shipments = {
      exportForUser: jest.fn().mockResolvedValue([{ id: 'ship-1' }]),
      buildCsv: jest.fn().mockReturnValue('shipmentId\nship-1'),
      buildPdf: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
    };
    redis = { setPx: jest.fn().mockResolvedValue(undefined) };
    processor = new ShipmentsExportProcessor(
      queue as unknown as QueueService,
      shipments as unknown as ShipmentsService,
      redis as unknown as RedisService,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
    );
  });

  const makeJob = (format: 'csv' | 'pdf') =>
    ({
      id: 'job-42',
      data: {
        userId: 'user-1',
        stellarAddress: 'GBUYER',
        isAdmin: false,
        format,
      },
    }) as unknown as Job<ShipmentsExportJobData>;

  it('registers a worker for the exports queue', () => {
    processor.onModuleInit();

    expect(queue.createWorker).toHaveBeenCalledWith(
      QUEUE_EXPORTS,
      expect.any(Function),
    );
  });

  it('builds a CSV for the caller and stores it in Redis', async () => {
    const result = await processor.process(makeJob('csv'));

    expect(shipments.exportForUser).toHaveBeenCalledWith('GBUYER', false);
    expect(result).toMatchObject({
      format: 'csv',
      contentType: 'text/csv',
      sizeBytes: Buffer.byteLength('shipmentId\nship-1'),
    });
    expect(redis.setPx).toHaveBeenCalledWith(
      exportResultKey('job-42'),
      Buffer.from('shipmentId\nship-1').toString('base64'),
      3_600_000,
    );
  });

  it('builds a PDF when requested', async () => {
    const result = await processor.process(makeJob('pdf'));

    expect(shipments.buildPdf).toHaveBeenCalled();
    expect(result.contentType).toBe('application/pdf');
    expect(redis.setPx).toHaveBeenCalledWith(
      exportResultKey('job-42'),
      Buffer.from('pdf-bytes').toString('base64'),
      3_600_000,
    );
  });
});
