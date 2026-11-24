import { Module } from '@nestjs/common';
import { ChainController } from './chain.controller';
import { TransactionPrepareController } from './transaction-prepare.controller';
import { TransactionRelayService } from './transaction-relay.service';
import { RedisModule } from '../../common/redis/redis.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [RedisModule, PrismaModule, NotificationsModule],
  controllers: [ChainController, TransactionPrepareController],
  providers: [TransactionRelayService],
})
export class ChainModule {}
