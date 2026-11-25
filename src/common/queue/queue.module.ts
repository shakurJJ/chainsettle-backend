import { Global, Module } from '@nestjs/common';
import { QueueAdminController } from './queue-admin.controller';
import { QueueService } from './queue.service';

/**
 * Global so producers in any feature module and the metrics collector can
 * inject {@link QueueService} without importing this module explicitly (#661).
 */
@Global()
@Module({
  controllers: [QueueAdminController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
