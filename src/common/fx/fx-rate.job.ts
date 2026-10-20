import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FxRateService } from './fx-rate.service';
import { RedisService } from '../redis/redis.service';
import { runTrackedJob } from '../jobs/job-tracker.util';

@Injectable()
export class FxRateJob {
  private readonly logger = new Logger(FxRateJob.name);

  constructor(
    private readonly fxRate: FxRateService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  @Cron('*/5 * * * *', { name: 'fx-rate-refresh' })
  async refresh() {
    const execute = async () => {
      this.logger.debug('Refreshing FX rates');
      await Promise.all([
        this.fxRate.refreshAllRates(),
        this.fxRate.refreshFiatRates(),
      ]);
    };

    if (this.redis) {
      await runTrackedJob(this.redis, 'fx-rate-refresh', execute, this.logger);
    } else {
      await execute();
    }
  }
}
