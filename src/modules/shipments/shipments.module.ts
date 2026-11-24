import { Module } from '@nestjs/common';
import { ShipmentsController } from './shipments.controller';
import { AdminShipmentsController } from './admin-shipments.controller';
import { ShipmentsService } from './shipments.service';
import { ShipmentApprovalsService } from './shipment-approvals.service';
import { SavedFiltersService } from './saved-filters.service';
import { ShipmentArchivalJob } from './shipment-archival.job';
import { ShipmentRemindersService } from './shipment-reminders.service';
import { ShipmentReminderJob } from './shipment-reminder.job';
import { LateDeliveryJob } from './late-delivery.job';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { RedisModule } from '../../common/redis/redis.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [NotificationsModule, WebhooksModule, RedisModule, AuditLogsModule, AuthModule],
  controllers: [ShipmentsController, AdminShipmentsController, CommentsController],
  providers: [
    ShipmentsService,
    ShipmentApprovalsService,
    SavedFiltersService,
    CommentsService,
    ShipmentArchivalJob,
    ShipmentRemindersService,
    ShipmentReminderJob,
    LateDeliveryJob,
  ],
  exports: [ShipmentsService, ShipmentApprovalsService, SavedFiltersService, LateDeliveryJob],
})
export class ShipmentsModule { }


