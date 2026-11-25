import { Global, Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagGuard } from '../../common/guards/feature-flag.guard';
import { FeatureFlagsAdminController } from './feature-flags-admin.controller';

/**
 * Feature flags are consumed by guards on arbitrary controllers across the
 * app, so the module is global: a controller can apply FeatureFlagGuard
 * without its own module having to import anything.
 *
 * RedisService is already provided globally by RedisModule.
 * PrismaModule and AuditLogsModule are global, so they are available to the
 * admin controller without explicit imports.
 */
@Global()
@Module({
  controllers: [FeatureFlagsAdminController],
  providers: [FeatureFlagsService, FeatureFlagGuard],
  exports: [FeatureFlagsService, FeatureFlagGuard],
})
export class FeatureFlagsModule {}