import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { OutboxDispatcherJob } from './outbox-dispatcher.job';
import { OutboxService } from './outbox.service';

@Module({
  imports: [WebhooksModule],
  providers: [OutboxService, OutboxDispatcherJob],
  exports: [OutboxService],
})
export class OutboxModule {}
