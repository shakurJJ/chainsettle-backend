import { Module } from '@nestjs/common';
import { RedisModule } from '../../common/redis/redis.module';
import { DevController } from './dev.controller';

@Module({
  imports: [RedisModule],
  controllers: [DevController],
})
export class DevModule {}
