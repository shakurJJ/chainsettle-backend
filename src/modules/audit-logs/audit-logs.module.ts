import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { AuditLogArchivalJob } from './audit-log-archival.job';
import { RedisModule } from '../../common/redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [AuditLogService, AuditLogInterceptor, AuditLogArchivalJob],
  controllers: [AuditLogsController],
  exports: [AuditLogService, AuditLogInterceptor, AuditLogArchivalJob],
})
export class AuditLogsModule {}
