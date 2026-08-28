import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { TokenRegistryModule } from '../token-registry/token-registry.module';
import { FxRateService } from './fx-rate.service';
import { FxRateJob } from './fx-rate.job';

@Global()
@Module({
  imports: [RedisModule, TokenRegistryModule],
  providers: [FxRateService, FxRateJob],
  exports: [FxRateService],
})
export class FxModule {}
