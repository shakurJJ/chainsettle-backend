import { Module } from '@nestjs/common';
import { ShipmentsController } from './shipments.controller';
import { AdminShipmentsController } from './admin-shipments.controller';
import { ShipmentsService } from './shipments.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../../common/redis/redis.module';

@Module({
  imports: [NotificationsModule, RedisModule, AuditLogsModule],
  controllers: [ShipmentsController, AdminShipmentsController, CommentsController],
  providers: [ShipmentsService, CommentsService],
  exports: [ShipmentsService],
})
export class ShipmentsModule { }


