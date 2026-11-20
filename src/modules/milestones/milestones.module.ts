// milestones.module.ts
import { Module } from '@nestjs/common';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { CalendarService } from './calendar.service';
import { UserCalendarController } from './user-calendar.controller';
import { MilestoneDeadlineJob } from './milestone-deadline.job';
import { DisputeEscalationJob } from './dispute-escalation.job';
import { MilestoneChecklistController } from './milestone-checklist.controller';
import { MilestoneChecklistService } from './milestone-checklist.service';
import { ExtensionRequestsController } from './extension-requests.controller';
import { ExtensionRequestsService } from './extension-requests.service';
import { RejectionReasonsController } from './rejection-reasons.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [NotificationsModule, ShipmentsModule, AuditLogsModule],
  controllers: [
    MilestoneChecklistController,
    ExtensionRequestsController,
    MilestonesController,
    UserCalendarController,
    RejectionReasonsController,
  ],
  providers: [
    MilestonesService,
    CalendarService,
    MilestoneDeadlineJob,
    DisputeEscalationJob,
    MilestoneChecklistService,
    ExtensionRequestsService,
  ],
  exports: [MilestonesService, CalendarService, MilestoneChecklistService],
})
export class MilestonesModule {}
