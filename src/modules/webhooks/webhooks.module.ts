import { Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { AdminWebhooksController } from './admin-webhooks.controller';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ValidWebhookHeadersConstraint } from './dto/create-webhook.dto';
import { MetricsModule } from '../../common/metrics/metrics.module';

@Module({
  imports: [AuditLogsModule, MetricsModule],
  controllers: [WebhooksController, AdminWebhooksController],
  providers: [WebhooksService, ValidWebhookHeadersConstraint],
  exports: [WebhooksService],
})
export class WebhooksModule {}
