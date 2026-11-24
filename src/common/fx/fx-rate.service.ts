import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RedisService } from '../redis/redis.service';
import { TokenRegistryService } from '../token-registry/token-registry.service';
import {
  CircuitBreaker,
  CircuitBreakerSnapshot,
  CircuitOpenError,
} from '../utils/circuit-breaker';

export interface FxRate {
  rate: number; // token → USD
  asOf: string; // ISO-8601 timestamp of when the rate was fetched
  /**
   * Set when the rate is served from the last-known-good copy (the fresh
   * cache entry expired) or while the provider circuit breaker is open.
   */
  stale?: boolean;
}

/**
 * Enriched rate shape returned by the public API endpoints.
 * `stale` is true when the rate is older than FX_STALE_AFTER_MINUTES or absent.
 */
export interface FxRateEntry {
  rate: number | null;      // token → USD; null when never fetched
  updatedAt: string | null; // ISO-8601 of last successful fetch; null when never fetched
  source: string | null;    // FX_RATE_API_URL; null when not configured
  stale: boolean;           // true when rate is absent or older than FX_STALE_AFTER_MINUTES
}

/**
 * All fiat currency codes the platform supports for display conversion.
 * Stored on User.displayCurrency; also accepted as ?currency= query param.
 *
 * Rules:
 *  - USD is always valid (it IS the base — no cross-rate needed).
 *  - Every other code must have a USD→X rate in Redis (`fx:fiat:{CODE}`)
 *    for conversion to succeed; if the rate is missing the field is omitted
 *    from responses rather than causing an error.
 */
export const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'NGN', 'KES', 'GHS', 'ZAR', 'EGP', 'AED',
  'INR', 'CNY', 'JPY', 'KRW', 'SGD', 'BRL', 'MXN', 'CAD', 'AUD',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Validates a currency code against SUPPORTED_CURRENCIES.
 * Throws BadRequestException with a helpful message if invalid.
 */
export function assertSupportedCurrency(code: string): asserts code is SupportedCurrency {
  const upper = code.toUpperCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(upper)) {
    throw new BadRequestException(
      `Unsupported currency '${code}'. Supported currencies: ${SUPPORTED_CURRENCIES.join(', ')}.`,
    );
  }
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
 *
 * Provider calls go through a circuit breaker: after
 * FX_BREAKER_FAILURE_THRESHOLD consecutive failures the provider is skipped
 * for FX_BREAKER_COOLDOWN_SECONDS, and the last successfully fetched rate is
 * served with `stale: true` instead of waiting on a timeout every call.
 */
@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);
  private readonly cacheTtlSeconds: number;
  private readonly apiUrl?: string;
  private readonly staleAfterMs: number;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly tokenRegistry: TokenRegistryService,
  ) {
    this.cacheTtlSeconds = this.config.get<number>('FX_RATE_CACHE_TTL_SECONDS', 300);
    this.apiUrl = this.config.get<string>('FX_RATE_API_URL') || undefined;
    const staleAfterMinutes = this.config.get<number>('FX_STALE_AFTER_MINUTES', 10);
    this.staleAfterMs = staleAfterMinutes * 60 * 1000;
    this.breaker = new CircuitBreaker('fx-provider', {
      failureThreshold: Number(this.config.get<number>('FX_BREAKER_FAILURE_THRESHOLD', 5)),
      cooldownMs: Number(this.config.get<number>('FX_BREAKER_COOLDOWN_SECONDS', 60)) * 1000,
    });
  }

  private cacheKey(symbol: string): string {
    return `fx:rate:${symbol.toUpperCase()}`;
  }

  /** Redis key for a USD→fiat cross-rate (e.g. `fx:fiat:EUR`). */
  private fiatCacheKey(currency: string): string {
    return `fx:fiat:${currency.toUpperCase()}`;
  }

  /**
   * Last successfully fetched value for a cache key, stored without a TTL so
   * it outlives the fresh entry while the provider is unavailable.
   */
  private lastKnownKey(cacheKey: string): string {
    return `${cacheKey}:last`;
  }

  /** Circuit breaker state for the FX provider (exposed in /health/detailed). */
  getBreakerState(): CircuitBreakerSnapshot {
    return this.breaker.getSnapshot();
  }

  /**
   * Reads the fresh cached rate, falling back to the last-known-good copy
   * when the fresh entry has expired. Fallback values, and any value read
   * while the breaker is open, are marked `stale: true`.
   */
  private async readCachedRate(cacheKey: string): Promise<FxRate | null> {
    const fresh = await this.redis.getJson<FxRate>(cacheKey);
    if (fresh) {
      return this.breaker.isOpen() ? { ...fresh, stale: true } : fresh;
    }
    const lastKnown = await this.redis.getJson<FxRate>(this.lastKnownKey(cacheKey));
    return lastKnown ? { ...lastKnown, stale: true } : null;
  }

  /** Writes a freshly fetched rate to both the TTL'd cache and the last-known copy. */
  private async storeRate(cacheKey: string, rate: number): Promise<void> {
    const value: FxRate = { rate, asOf: new Date().toISOString() };
    await Promise.all([
      this.redis.setJson(cacheKey, value, this.cacheTtlSeconds),
      this.redis.setJson(this.lastKnownKey(cacheKey), value),
    ]);
  }

  /**
   * Calls the FX provider through the circuit breaker. Invalid payloads count
   * as failures. Throws CircuitOpenError without calling out while open.
   */
  private async fetchRate(params: Record<string, string>, label: string): Promise<number> {
    return this.breaker.exec(async () => {
      const res = await axios.get(this.apiUrl!, { params, timeout: 5_000 });
      const rate = Number(res.data?.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid rate payload for ${label}: ${JSON.stringify(res.data)}`);
      }
      return rate;
    });
  }

  /**
   * Reads the cached USD→fiat rate for `currency`.
   * Returns 1 when currency is USD (no conversion needed).
   * Returns null when no rate has been fetched yet.
   */
  async getFiatRate(currency: string): Promise<FxRate | null> {
    const upper = currency.toUpperCase();
    if (upper === 'USD') return { rate: 1, asOf: new Date().toISOString() };
    try {
      return await this.readCachedRate(this.fiatCacheKey(upper));
    } catch (err: any) {
      this.logger.warn(`Fiat rate cache read failed for ${upper}: ${err.message}`);
      return null;
    }
  }

  /**
   * Convert a raw on-chain token amount to a display-currency value.
   *
   * Pipeline:
   *   rawBaseUnits → human amount (float) → × token/USD rate → × USD/target rate
   *
   * Returns null when either FX rate is unavailable — callers omit the field
   * rather than blocking the response.
   *
   * @param tokenSymbol   - e.g. 'USDC'
   * @param rawAmount     - bigint in smallest unit (stroops)
   * @param decimals      - token decimal places (usually 7 for Stellar tokens)
   * @param targetCurrency - ISO-4217 display currency, e.g. 'EUR'
   * @param humanAmount   - pre-computed float if already available (avoids double conversion)
   */
  async convertForDisplay(
    tokenSymbol: string,
    rawAmount: bigint | number,
    decimals: number,
    targetCurrency: string,
    humanAmount?: number,
  ): Promise<{
    amount: number;
    currency: string;
    rate: number;      // effective token → targetCurrency rate
    asOf: string;
    precision: number;
    stale?: boolean;   // present (true) when either rate is stale
  } | null> {
    const upper = targetCurrency.toUpperCase();

    const [tokenUsd, fiatRate] = await Promise.all([
      this.getUsdRate(tokenSymbol),
      this.getFiatRate(upper),
    ]);

    if (!tokenUsd || !fiatRate) return null;

    const human =
      humanAmount ??
      (typeof rawAmount === 'bigint'
        ? Number(rawAmount) / 10 ** decimals
        : rawAmount);

    const effectiveRate = tokenUsd.rate * fiatRate.rate;
    const amount = this.formatValue(human, effectiveRate, upper);
    const precision = this.getDisplayPrecision(upper);

    // Use the older of the two timestamps so stale is surfaced accurately
    const asOf =
      tokenUsd.asOf < (fiatRate.asOf ?? tokenUsd.asOf) ? tokenUsd.asOf : fiatRate.asOf ?? tokenUsd.asOf;

    const stale = !!(tokenUsd.stale || fiatRate.stale);

    return { amount, currency: upper, rate: effectiveRate, asOf, precision, ...(stale && { stale: true }) };
  }

  /** Fetches and caches USD→fiat cross-rates for every supported non-USD currency. */
  async refreshFiatRates(): Promise<void> {
    if (!this.apiUrl) return;

    const fiats = (SUPPORTED_CURRENCIES as readonly string[]).filter((c) => c !== 'USD');
    await Promise.all(fiats.map((currency) => this.refreshOneFiatRate(currency)));
  }

  private async refreshOneFiatRate(currency: string): Promise<void> {
    try {
      // Reuse the same external API — pass `fiat=USD` (base) and `target=CURRENCY`
      // convention. If the API uses a different param name operators can adapt
      // FX_RATE_API_URL to point at a compatible endpoint.
      const rate = await this.fetchRate({ base: 'USD', target: currency }, `USD→${currency}`);
      await this.storeRate(this.fiatCacheKey(currency), rate);
    } catch (err: any) {
      if (err instanceof CircuitOpenError) {
        this.logger.debug(`Skipping fiat rate fetch for USD→${currency}: ${err.message}`);
        return;
      }
      this.logger.warn(`Fiat rate fetch failed for USD→${currency}: ${err.message}`);
    }
  }

  /**
   * Reads the cached token/USD rate. Returns null when no rate has been
   * fetched yet or the cache entry has expired — callers must treat this as
   * "omit the field", never as an error.
   */
  async getUsdRate(tokenSymbol: string): Promise<FxRate | null> {
    try {
      return await this.readCachedRate(this.cacheKey(tokenSymbol));
    } catch (err: any) {
      this.logger.warn(`FX rate cache read failed for ${tokenSymbol}: ${err.message}`);
      return null;
    }
  }

  /**
   * Returns a single rate entry enriched with a `stale` flag and `source`.
   * Returns null when the symbol is not registered.
   * Throws NotFoundException when the symbol is registered but has no cached
   * rate yet (callers decide how to surface that).
   */
  async getRateEntry(symbol: string): Promise<FxRateEntry | null> {
    const upper = symbol.toUpperCase();
    const tokens = this.tokenRegistry.listTokens();
    const token = tokens.find((t) => t.symbol === upper);
    if (!token) return null;

    const raw = await this.getUsdRate(upper);
    return this.toEntry(raw);
  }

  /**
   * Returns rate entries for every registered token.
   * Tokens with no cached rate have rate=null, asOf=null, stale=true.
   */
  async getAllRateEntries(): Promise<Array<{ symbol: string } & FxRateEntry>> {
    const tokens = this.tokenRegistry.listTokens();
    return Promise.all(
      tokens.map(async (token) => {
        const raw = await this.getUsdRate(token.symbol);
        return { symbol: token.symbol, ...this.toEntry(raw) };
      }),
    );
  }

  private toEntry(raw: FxRate | null): FxRateEntry {
    const stale =
      raw === null ||
      raw.stale === true ||
      Date.now() - new Date(raw.asOf).getTime() > this.staleAfterMs;

    return {
      rate: raw?.rate ?? null,
      updatedAt: raw?.asOf ?? null,
      source: this.apiUrl ?? null,
      stale,
    };
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
      const rate = await this.fetchRate({ symbol }, symbol);
      await this.storeRate(this.cacheKey(symbol), rate);
    } catch (err: any) {
      // A failed fetch just leaves the previous cached rate (or nothing) in
      // place — readers fall back to the last-known rate marked stale.
      if (err instanceof CircuitOpenError) {
        this.logger.debug(`Skipping FX rate fetch for ${symbol}: ${err.message}`);
        return;
      }
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
