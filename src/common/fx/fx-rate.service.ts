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
 * Number of decimal places used when formatting a converted value for display.
 * Based on ISO 4217 minor-unit conventions. Currencies not listed here default
 * to 2 decimal places (the most common case).
 *
 * Zero-decimal currencies: JPY, KRW, VND, IDR, BIF, CLP, GNF, ISK, KMF, MGA,
 * PYG, RWF, UGX, XAF, XOF, XPF.
 * Four-decimal currencies: BHD, IQD, JOD, KWD, LYD, OMR, TND.
 */
const CURRENCY_PRECISION_MAP: Record<string, number> = {
  // Zero-decimal currencies
  JPY: 0, KRW: 0, VND: 0, IDR: 0, BIF: 0, CLP: 0, GNF: 0, ISK: 0,
  KMF: 0, MGA: 0, PYG: 0, RWF: 0, UGX: 0, XAF: 0, XOF: 0, XPF: 0,
  // Four-decimal currencies
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

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

  // ----------------------------------------------------------
  // Display precision helpers (Issue #307)
  // ----------------------------------------------------------

  /**
   * Returns the default number of decimal places for a given display currency.
   * Falls back to 2 for any currency not listed in CURRENCY_PRECISION_MAP.
   */
  getDisplayPrecision(currencyCode: string): number {
    return CURRENCY_PRECISION_MAP[currencyCode.toUpperCase()] ?? 2;
  }

  /**
   * Convert a raw token amount to a display-currency value and round it to
   * the appropriate number of decimal places.
   *
   * @param amount        - Raw token amount (e.g. 10.5 XLM)
   * @param rate          - Token → display-currency exchange rate
   * @param currencyCode  - Target display currency (e.g. "USD", "JPY")
   * @param precisionOverride - Optional caller-supplied decimal precision; overrides the
   *                            currency-appropriate default when provided.
   * @returns The converted value as a number rounded to the correct precision.
   */
  formatValue(
    amount: number,
    rate: number,
    currencyCode: string,
    precisionOverride?: number,
  ): number {
    const precision =
      precisionOverride !== undefined && Number.isInteger(precisionOverride) && precisionOverride >= 0
        ? precisionOverride
        : this.getDisplayPrecision(currencyCode);

    const raw = amount * rate;
    const factor = 10 ** precision;
    return Math.round(raw * factor) / factor;
  }
}
