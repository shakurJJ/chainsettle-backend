import { Module, Global } from '@nestjs/common';
import { IpfsService } from './ipfs.service';
import { IpfsController } from './ipfs.controller';
import { IpfsAdminController } from './ipfs-admin.controller';
import { RedisModule } from '../redis/redis.module';

@Global()
@Module({
  imports: [RedisModule],
  controllers: [IpfsController, IpfsAdminController],
  providers: [IpfsService],
  exports: [IpfsService],
})
export class IpfsModule {}
