// milestones.module.ts
import { Module } from '@nestjs/common';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { CalendarService } from './calendar.service';
import { UserCalendarController } from './user-calendar.controller';
import { MilestoneDeadlineJob } from './milestone-deadline.job';
import { DisputeEscalationJob } from './dispute-escalation.job';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [NotificationsModule, ShipmentsModule, AuditLogsModule],
  controllers: [MilestonesController, UserCalendarController],
  providers: [MilestonesService, CalendarService, MilestoneDeadlineJob, DisputeEscalationJob],
  exports: [MilestonesService, CalendarService],
})
export class MilestonesModule {}
