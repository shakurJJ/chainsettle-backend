import {
  BadGatewayException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { RedisService } from '../../common/redis/redis.service';

const FRIENDBOT_URLS: Record<string, string> = {
  testnet: 'https://friendbot.stellar.org',
  futurenet: 'https://friendbot-futurenet.stellar.org',
};

export class FundAccountDto {
  @ApiProperty({ description: 'Stellar Ed25519 public key to fund', example: 'GABC...' })
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'address must be a valid Stellar public key' })
  address: string;
}

/**
 * Development helpers. Only active on testnet / futurenet — every route
 * returns 404 on mainnet.
 */
@ApiTags('dev')
@Controller('dev')
export class DevController {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  @Post('fund')
  @Public()
  @ApiOperation({ summary: 'Fund a testnet/futurenet account via Friendbot (404 on mainnet)' })
  @ApiResponse({ status: 201, description: 'Account funded; returns the transaction hash' })
  @ApiResponse({ status: 404, description: 'Not available on this network' })
  @ApiResponse({ status: 429, description: 'Address funded too recently' })
  async fund(@Body() dto: FundAccountDto) {
    const network = this.config.get<string>('STELLAR_NETWORK') ?? 'testnet';
    const base = this.config.get<string>('FRIENDBOT_URL') || FRIENDBOT_URLS[network];
    if (!FRIENDBOT_URLS[network] || !base) throw new NotFoundException();

    const windowSec = Number(this.config.get('DEV_FUND_RATE_LIMIT_SECONDS') ?? 3600);
    const key = `dev:fund:${dto.address}`;
    const acquired = await this.redis.getClient().set(key, '1', 'EX', windowSec, 'NX');
    if (!acquired) {
      throw new HttpException(`Address was funded recently; retry in ${await this.redis.ttl(key)}s`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const res = await fetch(`${base}?addr=${encodeURIComponent(dto.address)}`).catch(() => null);
    const body: any = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      await this.redis.del(key);
      throw new BadGatewayException(body?.detail ?? 'Friendbot request failed');
    }
    return { address: dto.address, network, hash: body.hash ?? body.id };
  }
}
