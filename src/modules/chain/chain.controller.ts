import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StellarService } from '../../common/stellar/stellar.service';
import { RedisService } from '../../common/redis/redis.service';
import { Throttle } from '@nestjs/throttler';
import { AddressParamDto } from './address-param.dto';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('chain')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chain')
export class ChainController {
  constructor(
    private readonly stellar: StellarService,
    private readonly redis: RedisService,
  ) {}

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
}
