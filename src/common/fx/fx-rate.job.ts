import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FxRateService } from './fx-rate.service';

@Injectable()
export class FxRateJob {
  private readonly logger = new Logger(FxRateJob.name);

  constructor(private readonly fxRate: FxRateService) {}

  @Cron('*/5 * * * *')
  async refresh() {
    this.logger.debug('Refreshing FX rates');
    await this.fxRate.refreshAllRates();
  }
}
