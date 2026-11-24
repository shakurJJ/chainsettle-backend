import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../../common/redis/redis.module';
import { RecurringSchedulesController } from './recurring-schedules.controller';
import { RecurringSchedulesService } from './recurring-schedules.service';
import { RecurringScheduleJob } from './recurring-schedule.job';

@Module({
  imports: [NotificationsModule, RedisModule],
  controllers: [RecurringSchedulesController],
  providers: [RecurringSchedulesService, RecurringScheduleJob],
  exports: [RecurringSchedulesService],
})
export class RecurringSchedulesModule {}
