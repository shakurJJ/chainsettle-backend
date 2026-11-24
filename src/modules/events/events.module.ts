// events.module.ts
import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { BackfillService } from './backfill.service';
import { ReconciliationJob } from './reconciliation.job';
import { MilestonesModule } from '../milestones/milestones.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [MilestonesModule, NotificationsModule, ShipmentsModule, AuditLogsModule],
  providers: [EventsService, BackfillService, ReconciliationJob],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
