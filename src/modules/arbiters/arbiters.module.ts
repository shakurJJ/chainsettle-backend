import { Module } from '@nestjs/common';
import { ArbitersController } from './arbiters.controller';
import { AdminArbitersController } from './admin-arbiters.controller';
import { ArbitersService } from './arbiters.service';
import { ArbiterReputationJob } from './arbiter-reputation.job';

@Module({
  controllers: [ArbitersController, AdminArbitersController],
  providers: [ArbitersService, ArbiterReputationJob],
  exports: [ArbitersService],
})
export class ArbitersModule {}
