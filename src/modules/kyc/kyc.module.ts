import { Global, Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Global()
@Module({
  imports: [AuditLogsModule],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
