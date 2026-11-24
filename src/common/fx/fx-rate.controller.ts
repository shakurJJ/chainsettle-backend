import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiProperty,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../decorators/public.decorator';
import { FxRateService, FxRateEntry } from './fx-rate.service';

// DTO-style classes for Swagger schema generation only
class FxRateEntrySchema implements FxRateEntry {
  @ApiProperty({ example: 1.0, nullable: true, description: 'Token → USD exchange rate; null when no rate has been fetched yet' })
  rate: number | null;

  @ApiProperty({ example: '2026-09-29T10:00:00.000Z', nullable: true, description: 'ISO-8601 timestamp of the last successful rate fetch' })
  updatedAt: string | null;

  @ApiProperty({ example: 'https://api.example.com/fx', nullable: true, description: 'URL of the rate source configured via FX_RATE_API_URL; null when not configured' })
  source: string | null;

  @ApiProperty({ example: false, description: 'true when the rate is absent or older than FX_STALE_AFTER_MINUTES' })
  stale: boolean;
}

class AllRatesResponseSchema {
  @ApiProperty({ example: 'USD', description: 'The quote currency — all rates are token → USD' })
  base: string;

  @ApiProperty({
    example: { USDC: { rate: 1.0, updatedAt: '2026-09-29T10:00:00.000Z', source: 'https://...', stale: false } },
    description: 'Map of token symbol → rate entry',
  })
  rates: Record<string, FxRateEntrySchema>;
}

/**
 * FxRateController
 *
 * Public (no JWT required) endpoints that expose the cached token/USD
 * exchange rates maintained by FxRateService.
 *
 * Routes:
 *   GET /fx/rates           — all registered tokens
 *   GET /fx/rates/:symbol   — single token
 *
 * Both routes:
 *  - Are @Public() — no authentication required.
 *  - Apply a tighter throttle (60 req/60 s) than the global default so a
 *    unauthenticated client cannot use this as a free polling target.
 *  - Set Cache-Control: public, max-age=60, stale-while-revalidate=240 so
 *    CDN/proxy layers can cache the response for up to 1 minute, then
 *    serve stale for a further 4 minutes while revalidating in the background.
 *    (The job refreshes every 5 minutes, so a 1-minute CDN cache is always
 *    within one refresh cycle of truth.)
 *
 * The `stale` field in each entry reflects whether the backend's own cached
 * rate is older than FX_STALE_AFTER_MINUTES (default 10 min). A stale rate
 * is still served — the flag lets the client show a warning rather than
 * blocking the user.
 */
@ApiTags('fx')
@Controller('fx')
export class FxRateController {
  constructor(private readonly fxRate: FxRateService) {}

  /**
   * GET /fx/rates
   *
   * Returns all registered token/USD rates.
   * Tokens that have never been fetched appear with rate=null, stale=true.
   */
  @Get('rates')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=240')
  @ApiOperation({
    summary: 'Get all cached token/USD exchange rates',
    description:
      'Returns a map of every registered token symbol to its current cached ' +
      'USD exchange rate. Rates are updated by the FX job every 5 minutes. ' +
      'The `stale` flag is true when the rate is absent or older than ' +
      'FX_STALE_AFTER_MINUTES (default 10 min). No authentication required.',
  })
  @ApiResponse({
    status: 200,
    description: 'All registered token rates',
    type: AllRatesResponseSchema,
  })
  async getAllRates(): Promise<{ base: string; rates: Record<string, FxRateEntry> }> {
    const entries = await this.fxRate.getAllRateEntries();

    const rates: Record<string, FxRateEntry> = {};
    for (const { symbol, ...entry } of entries) {
      rates[symbol] = entry;
    }

    return { base: 'USD', rates };
  }

  /**
   * GET /fx/rates/:symbol
   *
   * Returns the rate for a single token symbol (case-insensitive).
   * Returns 404 when the symbol is not registered.
   */
  @Get('rates/:symbol')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=240')
  @ApiOperation({
    summary: 'Get cached token/USD exchange rate for a single symbol',
    description:
      'Returns the current cached USD exchange rate for the given token symbol. ' +
      'Symbol lookup is case-insensitive. Returns 404 for symbols not in the ' +
      'token registry. No authentication required.',
  })
  @ApiParam({
    name: 'symbol',
    description: 'Token symbol, case-insensitive (e.g. USDC, usdc, EURC)',
    example: 'USDC',
  })
  @ApiResponse({
    status: 200,
    description: 'Rate entry for the requested symbol',
    schema: {
      example: {
        symbol: 'USDC',
        rate: 1.0,
        updatedAt: '2026-09-29T10:00:00.000Z',
        source: 'https://api.example.com/fx',
        stale: false,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Symbol is not in the token registry' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async getRate(
    @Param('symbol') symbol: string,
  ): Promise<{ symbol: string } & FxRateEntry> {
    const upper = symbol.toUpperCase();
    const entry = await this.fxRate.getRateEntry(upper);

    if (entry === null) {
      throw new NotFoundException(
        `Token symbol '${upper}' is not registered. ` +
          `Use GET /fx/rates to see all available symbols.`,
      );
    }

    return { symbol: upper, ...entry };
  }
}
