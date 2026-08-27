import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RedisService } from '../redis/redis.service';
import { TokenRegistryService } from '../token-registry/token-registry.service';

export interface FxRate {
  rate: number; // token → USD
  asOf: string; // ISO-8601 timestamp of when the rate was fetched
}

/**
 * Caches token/USD rates in Redis so shipment/milestone responses can show
 * an estimated USD value alongside raw token amounts. Rates are refreshed
 * on a schedule (see FxRateJob) rather than fetched per-request.
 */
@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);
  private readonly cacheTtlSeconds: number;
  private readonly apiUrl?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly tokenRegistry: TokenRegistryService,
  ) {
    this.cacheTtlSeconds = this.config.get<number>('FX_RATE_CACHE_TTL_SECONDS', 300);
    this.apiUrl = this.config.get<string>('FX_RATE_API_URL') || undefined;
  }

  private cacheKey(symbol: string): string {
    return `fx:rate:${symbol.toUpperCase()}`;
  }

  /**
   * Reads the cached token/USD rate. Returns null when no rate has been
   * fetched yet or the cache entry has expired — callers must treat this as
   * "omit the field", never as an error.
   */
  async getUsdRate(tokenSymbol: string): Promise<FxRate | null> {
    try {
      return await this.redis.getJson<FxRate>(this.cacheKey(tokenSymbol));
    } catch (err: any) {
      this.logger.warn(`FX rate cache read failed for ${tokenSymbol}: ${err.message}`);
      return null;
    }
  }

  /** Fetches and caches the USD rate for every registered token. */
  async refreshAllRates(): Promise<void> {
    if (!this.apiUrl) {
      this.logger.debug('FX_RATE_API_URL not configured — skipping FX rate refresh');
      return;
    }

    const tokens = this.tokenRegistry.listTokens();
    await Promise.all(tokens.map((token) => this.refreshRate(token.symbol)));
  }

  private async refreshRate(symbol: string): Promise<void> {
    try {
      const res = await axios.get(this.apiUrl!, { params: { symbol }, timeout: 5000 });
      const rate = Number(res.data?.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid rate payload: ${JSON.stringify(res.data)}`);
      }
      await this.redis.setJson(this.cacheKey(symbol), { rate, asOf: new Date().toISOString() }, this.cacheTtlSeconds);
    } catch (err: any) {
      // A failed fetch just leaves the previous cached rate (or nothing) in
      // place — callers already treat a missing rate as "omit the field".
      this.logger.warn(`FX rate fetch failed for ${symbol}: ${err.message}`);
    }
  }
}
