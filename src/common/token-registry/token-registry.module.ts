import { Global, Module } from '@nestjs/common';
import { TokenRegistryService } from './token-registry.service';
import { AdminTokenRegistryController, TokenRegistryController } from './token-registry.controller';
import { AuditLogsModule } from '../../modules/audit-logs/audit-logs.module';

@Global()
@Module({
  imports: [AuditLogsModule],
  controllers: [TokenRegistryController, AdminTokenRegistryController],
  providers: [TokenRegistryService],
  exports: [TokenRegistryService],
})
export class TokenRegistryModule {}
