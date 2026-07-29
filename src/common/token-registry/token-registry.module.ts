import { Global, Module } from '@nestjs/common';
import { TokenRegistryService } from './token-registry.service';
import { AdminTokenRegistryController, TokenRegistryController } from './token-registry.controller';

@Global()
@Module({
  controllers: [TokenRegistryController,  AdminTokenRegistryController],
  providers: [TokenRegistryService],
  exports: [TokenRegistryService],
})
export class TokenRegistryModule {}
