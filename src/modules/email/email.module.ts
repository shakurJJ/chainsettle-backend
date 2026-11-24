import { Module } from '@nestjs/common';
import { EmailSuppressionService } from './email-suppression.service';
import { EmailEventsController } from './email-events.controller';
import { AdminEmailSuppressionsController } from './admin-email-suppressions.controller';

@Module({
  controllers: [EmailEventsController, AdminEmailSuppressionsController],
  providers: [EmailSuppressionService],
  exports: [EmailSuppressionService],
})
export class EmailModule {}
