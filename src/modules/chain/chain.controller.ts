import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StellarService } from '../../common/stellar/stellar.service';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Throttle } from '@nestjs/throttler';
import { AddressParamDto } from './address-param.dto';
import { TxHashParamDto } from './tx-hash-param.dto';
import { Public } from '../../common/decorators/public.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { StellarAddressThrottlerGuard } from '../../common/guards/stellar-address-throttler.guard';
import { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { TransactionRelayService } from './transaction-relay.service';

/** Redis TTL for finalized (SUCCESS / FAILED) transaction responses — 24 hours */
const TX_FINAL_CACHE_TTL = 86_400;

@ApiTags('chain')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chain')
export class ChainController {
  constructor(
    private readonly stellar: StellarService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly relay: TransactionRelayService,
  ) {}

  /**
   * POST /chain/submit
   * Relays a client-signed transaction; the final status is pushed over
   * WebSocket as a `chain:tx` event.
   */
  @Post('submit')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(StellarAddressThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Relay a signed transaction and track its status' })
  submit(@Body() dto: SubmitTransactionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.relay.submit(dto.signedXdr, user);
  }

  @Get('ledger/:number')
  @ApiOperation({ summary: 'Look up Stellar ledger metadata by sequence number' })
  async getLedger(@Param('number', new ParseIntPipe({ errorHttpStatusCode: 400 })) number: number) {
    if (number < 1) throw new BadRequestException('Ledger sequence must be a positive integer');

    const cacheKey = `chain:ledger:${number}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const ledger = await this.stellar.getLedger(number);
    if (!ledger) throw new NotFoundException(`Ledger ${number} not found on the network`);

    await this.redis.set(cacheKey, JSON.stringify(ledger), 86400); // 24h TTL
    return ledger;
  }

  @Get('account/:address')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Look up a Stellar account's XLM balance and trustlines" })
  @ApiParam({ name: 'address', description: 'Stellar Ed25519 public key' })
  async getAccount(@Param() params: AddressParamDto) {
    const info = await this.stellar.getAccountInfo(params.address);
    if (!info) {
      throw new NotFoundException(`Account ${params.address} not found on-chain`);
    }
    return info;
  }

  @Get('contract/events/:txHash')
  @ApiOperation({ summary: 'Decode events emitted by a specific transaction' })
  async getTransactionEvents(@Param('txHash') txHash: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new BadRequestException('Transaction hash must be a 64-character hex string');
    }
    return this.stellar.getTransactionEvents(txHash);
  }

  @Get('status')
  @Public()
  @ApiOperation({ summary: 'Current Stellar network / RPC health snapshot' })
  async getStatus() {
    return this.stellar.getNetworkStatus();
  }

  @Get('fees')
  @ApiOperation({ summary: 'Get current Stellar network base fee and resource fee estimates' })
  async getFees() {
    const cacheKey = 'chain:fees';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const fees = await this.stellar.getFeeStats();
    await this.redis.set(cacheKey, JSON.stringify(fees), 30); // 30s TTL
    return fees;
  }

  // ----------------------------------------------------------
  // TRANSACTION STATUS LOOKUP
  // ----------------------------------------------------------

  @Get('transactions/:hash')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Look up the status and result of a submitted Stellar transaction',
    description:
      'Returns status (SUCCESS / FAILED / PENDING / NOT_FOUND), ledger, timestamps, ' +
      'fee, result code, decoded contract events, and a link to the related shipment ' +
      'when a ChainEvent with this tx hash exists in the database. ' +
      'SUCCESS and FAILED responses are cached in Redis for 24 h.',
  })
  @ApiParam({ name: 'hash', description: '64-character hex Stellar transaction hash' })
  @ApiResponse({ status: 200, description: 'Transaction found — status returned' })
  @ApiResponse({ status: 400, description: 'Invalid hash format (not a 64-char hex string)' })
  async getTransactionStatus(@Param() params: TxHashParamDto) {
    const { hash } = params;
    const cacheKey = `chain:tx:${hash}`;

    // Return cached response for finalized states
    const cached = await this.redis.getJson<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    // Fetch live status from Stellar RPC
    const tx = await this.stellar.getTransaction(hash);

    // Link to the related shipment if a matching ChainEvent exists
    let shipmentId: string | null = null;
    const chainEvent = await this.prisma.chainEvent.findFirst({
      where: { txHash: hash },
      select: { shipmentId: true },
    });
    if (chainEvent?.shipmentId) {
      shipmentId = chainEvent.shipmentId;
    }

    const response = { ...tx, shipmentId };

    // Only cache finalized states — SUCCESS and FAILED will not change
    if (tx.status === 'SUCCESS' || tx.status === 'FAILED') {
      await this.redis.setJson(cacheKey, response, TX_FINAL_CACHE_TTL);
    }

    return response;
  }
}
