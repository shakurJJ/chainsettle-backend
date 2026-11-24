import { Global, Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycExpiryJob } from './kyc-expiry.job';

@Global()
@Module({
  imports: [AuditLogsModule, NotificationsModule],
  controllers: [KycController],
  providers: [KycService, KycExpiryJob],
  exports: [KycService],
})
export class KycModule {}
