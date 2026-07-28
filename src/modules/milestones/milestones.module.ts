// milestones.module.ts
import { Module } from '@nestjs/common';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { MilestoneDeadlineJob } from './milestone-deadline.job';
import { DisputeEscalationJob } from './dispute-escalation.job';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [NotificationsModule, ShipmentsModule, AuditLogsModule],
  controllers: [MilestonesController],
  providers: [MilestonesService, MilestoneDeadlineJob, DisputeEscalationJob],
  exports: [MilestonesService],
})
export class MilestonesModule {}
