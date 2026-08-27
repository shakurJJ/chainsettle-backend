import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ArbitersService } from './arbiters.service';

/**
 * Recomputes reputation for every known arbiter on a schedule, rather than
 * per-request, so GET /arbiters/:address/reputation stays cheap (#232).
 */
@Injectable()
export class ArbiterReputationJob {
  private readonly logger = new Logger(ArbiterReputationJob.name);

  constructor(private readonly arbiters: ArbitersService) {}

  @Cron('0 */6 * * *')
  async recomputeAll() {
    const addresses = await this.arbiters.listKnownArbiterAddresses();
    this.logger.log(`Recomputing reputation for ${addresses.length} arbiter(s)`);

    for (const address of addresses) {
      try {
        await this.arbiters.recompute(address);
      } catch (err: any) {
        this.logger.error(`Failed to recompute reputation for arbiter ${address}: ${err.message}`);
      }
    }
  }
}
