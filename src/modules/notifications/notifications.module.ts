import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationDigestJob } from './notification-digest.job';
import { ShipmentReportService } from './shipment-report.service';
import { ShipmentReportJob } from './shipment-report.job';
import { NotificationCleanupJob } from './notification-cleanup.job';
import { OutboxModule } from '../outbox/outbox.module';
import { PushNotificationService } from './push-notification.service';
import { WebPushService } from './web-push.service';
import { TelegramService } from './telegram.service';
import { EmailProcessor } from './email.processor';

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
    OutboxModule,
  ],
  providers: [
    NotificationsService,
    NotificationsGateway,
    NotificationDigestJob,
    ShipmentReportService,
    ShipmentReportJob,
    PushNotificationService,
    WebPushService,
    TelegramService,
  ],
  controllers: [NotificationsController],
  exports: [NotificationsService, NotificationsGateway, PushNotificationService, WebPushService, TelegramService],
})
export class NotificationsModule {}
