import { Module } from '@nestjs/common';
import { ArbitersController } from './arbiters.controller';
import { AdminArbitersController } from './admin-arbiters.controller';
import { ArbitersService } from './arbiters.service';
import { ArbiterReputationJob } from './arbiter-reputation.job';
import { ArbiterDirectoryService } from './arbiter-directory.service';

@Module({
  controllers: [ArbitersController, AdminArbitersController],
  providers: [ArbitersService, ArbiterReputationJob, ArbiterDirectoryService],
  exports: [ArbitersService],
})
export class ArbitersModule {}
