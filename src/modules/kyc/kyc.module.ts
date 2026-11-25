import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycExpiryJob } from './kyc-expiry.job';
import { KYC_PROVIDER, KycProvider } from './kyc-provider.interface';
import { HmacKycProvider } from './providers/hmac-kyc.provider';

@Global()
@Module({
  imports: [AuditLogsModule, NotificationsModule],
  controllers: [KycController],
  providers: [
    KycService,
    KycExpiryJob,
    {
      provide: KYC_PROVIDER,
      useFactory: (config: ConfigService): KycProvider => {
        const providerName = config.get<string>('KYC_PROVIDER') ?? 'hmac';
        switch (providerName) {
          case 'hmac':
            return new HmacKycProvider(config.get<string>('KYC_WEBHOOK_SECRET'));
          default:
            throw new Error(
              `Unknown KYC provider "${providerName}". Supported providers: hmac.`,
            );
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: [KycService, KYC_PROVIDER],
})
export class KycModule {}