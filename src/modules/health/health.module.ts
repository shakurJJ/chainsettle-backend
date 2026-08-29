// health.module.ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AdminHealthController, HealthController } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController, AdminHealthController],
})
export class HealthModule {}
