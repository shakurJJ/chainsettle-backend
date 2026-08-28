import { Global, Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagGuard } from '../../common/guards/feature-flag.guard';

/**
 * Feature flags are consumed by guards on arbitrary controllers across the
 * app, so the module is global: a controller can apply FeatureFlagGuard
 * without its own module having to import anything.
 *
 * RedisService is already provided globally by RedisModule.
 */
@Global()
@Module({
  providers: [FeatureFlagsService, FeatureFlagGuard],
  exports: [FeatureFlagsService, FeatureFlagGuard],
})
export class FeatureFlagsModule {}
