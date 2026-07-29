import { Global, Module } from '@nestjs/common';
import { TokenRegistryService } from './token-registry.service';
import { TokenRegistryController } from './token-registry.controller';

@Global()
@Module({
  controllers: [TokenRegistryController],
  providers: [TokenRegistryService],
  exports: [TokenRegistryService],
})
export class TokenRegistryModule {}
