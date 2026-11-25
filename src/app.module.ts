import { Module, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { envValidationSchema } from './config/env.validation';
import { RolesGuard } from './common/guards/roles.guard';
import { AdminIpAllowlistGuard } from './common/guards/admin-ip-allowlist.guard';
import { GqlThrottlerGuard } from './common/guards/gql-throttler.guard';
import { ImpersonationGuard } from './common/guards/impersonation.guard';
import { DeprecationInterceptor } from './common/interceptors/deprecation.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
import { I18nModule } from './i18n/i18n.module';
import { LocaleMiddleware } from './i18n/locale.middleware';

import { PrismaModule } from './common/prisma/prisma.module';
import { StellarModule } from './common/stellar/stellar.module';
import { RedisModule } from './common/redis/redis.module';
import { IpfsModule } from './common/ipfs/ipfs.module';
import { TokenRegistryModule } from './common/token-registry/token-registry.module';
import { RedisThrottlerStorageService } from './common/throttler/redis-throttler-storage.service';
import { MetricsModule } from './common/metrics/metrics.module';
import { HttpMetricsInterceptor } from './common/interceptors/http-metrics.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { TimeoutGuard } from './common/guards/timeout.guard';
import { FxModule } from './common/fx/fx.module';

import { AuthModule } from './modules/auth/auth.module';
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { ShipmentTemplatesModule } from './modules/shipment-templates/shipment-templates.module';
import { RecurringSchedulesModule } from './modules/recurring-schedules/recurring-schedules.module';
import { MilestonesModule } from './modules/milestones/milestones.module';
import { EventsModule } from './modules/events/events.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { HealthModule } from './modules/health/health.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuditLogInterceptor } from './modules/audit-logs/audit-log.interceptor';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { ChainModule } from './modules/chain/chain.module';
import { DevModule } from './modules/dev/dev.module';
import { KycModule } from './modules/kyc/kyc.module';
import { ArbitersModule } from './modules/arbiters/arbiters.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { GraphqlModule } from './modules/graphql/graphql.module';
import { AdminDashboardModule } from './modules/admin-dashboard/admin-dashboard.module';
import { AdminDisputesModule } from './modules/admin-dashboard/admin-disputes.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettlementProposalsModule } from './modules/milestones/settlement-proposals.module';
import { ReportsModule } from './modules/reports/reports.module';

@Module({
  imports: [
    // Config — loads .env and makes ConfigService available everywhere
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // Rate limiting — protects all routes with Redis storage for multi-pod consistency
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('THROTTLE_TTL', 60) * 1000,
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
        storage: new RedisThrottlerStorageService(config),
      }),
    }),

    // Cron jobs — for Stellar event polling
    ScheduleModule.forRoot(),

    // Terminus health checks
    TerminusModule,

    // Shared infrastructure
    PrismaModule,
    StellarModule,
    RedisModule,
    IpfsModule,
    TokenRegistryModule,
    MetricsModule,
    FxModule,
    I18nModule,

    // Feature modules
    AuthModule,
    ShipmentsModule,
    ShipmentTemplatesModule,
    RecurringSchedulesModule,
    MilestonesModule,
    EventsModule,
    NotificationsModule,
    HealthModule,
    AuditLogsModule,
    WebhooksModule,
    OutboxModule,
    ChainModule,
    DevModule,
    KycModule,
    ArbitersModule,
    InvitationsModule,
    FeatureFlagsModule,
    GraphqlModule,
    AdminDashboardModule,
    AdminDisputesModule,
    ReportsModule,
    SettlementProposalsModule,
    ReportsModule,
  ],
  providers: [
    // Apply global throttler guard to REST and GraphQL (sets X-RateLimit-* on success and 429)
    {
      provide: APP_GUARD,
      useClass: AdminIpAllowlistGuard,
    },
    {
      provide: APP_GUARD,
      useClass: GqlThrottlerGuard,
    },
    // Apply TimeoutGuard to read @Timeout() decorator metadata
    {
      provide: APP_GUARD,
      useClass: TimeoutGuard,
    },
    // Apply global roles guard — enforces @Roles() decorator across all routes
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Block sensitive routes when using an impersonation token
    {
      provide: APP_GUARD,
      useClass: ImpersonationGuard,
    },
    // Emit Deprecation / Sunset headers for @DeprecatedRoute handlers
    {
      provide: APP_INTERCEPTOR,
      useClass: DeprecationInterceptor,
    },
    // Apply global audit logging interceptor (logs all mutations + impersonated requests)
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
    // Track HTTP request duration for all routes
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
    // Timeout requests that hang (slow RPC, stuck DB)
    {
      provide: APP_INTERCEPTOR,
      useClass: TimeoutInterceptor,
    },
    TimeoutGuard,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_FILTER,
      useClass: ThrottlerExceptionFilter,
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    // Runs before JWT guard — attaches X-Request-ID and locale to every request
    consumer.apply(RequestIdMiddleware, LocaleMiddleware).forRoutes('*');
  }
}
