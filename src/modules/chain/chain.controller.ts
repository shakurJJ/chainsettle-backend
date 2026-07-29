import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StellarService } from '../../common/stellar/stellar.service';
import { RedisService } from '../../common/redis/redis.service';

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
}
