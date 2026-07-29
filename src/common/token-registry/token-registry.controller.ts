import { Controller, Get, Param, NotFoundException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { TokenRegistryService } from './token-registry.service';
import { RedisService } from '../redis/redis.service';

const CACHE_KEY = 'token_registry:list';
const CACHE_TTL = 300; // 5 minutes

@ApiTags('tokens')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tokens')
export class TokenRegistryController {
  constructor(
    private readonly tokenRegistry: TokenRegistryService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all supported payment tokens' })
  @ApiResponse({ status: 200, description: 'Sorted list of registered tokens' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listTokens() {
    const cached = await this.redis.get(CACHE_KEY);
    if (cached) return JSON.parse(cached);

    const tokens = this.tokenRegistry.listTokens();
    await this.redis.set(CACHE_KEY, JSON.stringify(tokens), CACHE_TTL);
    return tokens;
  }

  @Get(':address')
  @ApiOperation({ summary: 'Get a single token registry entry by contract address' })
  @ApiParam({ name: 'address', description: 'Token contract address' })
  @ApiResponse({ status: 200, description: 'Token registry entry' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Address not found in the token registry' })
  getToken(@Param('address') address: string) {
    const token = this.tokenRegistry.findByAddress(address);
    if (!token) {
      throw new NotFoundException(`Token address ${address} not found in registry`);
    }
    return token;
  }
}
