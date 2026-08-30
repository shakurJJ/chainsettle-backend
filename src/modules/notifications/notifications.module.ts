import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationDigestJob } from './notification-digest.job';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PushNotificationService } from './push-notification.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
    WebhooksModule,
  ],
  providers: [NotificationsService, NotificationsGateway, NotificationDigestJob, PushNotificationService],
  controllers: [NotificationsController],
  exports: [NotificationsService, NotificationsGateway, PushNotificationService],
})
export class NotificationsModule {}
