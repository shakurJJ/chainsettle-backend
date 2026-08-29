import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArbitersService } from './arbiters.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AddressParamDto } from './dto/address-param.dto';

@ApiTags('arbiters')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('arbiters')
export class ArbitersController {
  constructor(private readonly arbitersService: ArbitersService) {}

  @Get(':address/reputation')
  @ApiOperation({ summary: "Get an arbiter's dispute-resolution reputation summary" })
  @ApiParam({ name: 'address', description: 'Stellar Ed25519 public key of the arbiter' })
  @ApiResponse({ status: 200, description: 'Reputation summary (neutral/empty when the arbiter has no history)' })
  getReputation(@Param() params: AddressParamDto) {
    return this.arbitersService.getReputation(params.address);
  }

  @Get(':address/history')
  @ApiOperation({ summary: "Get an arbiter's paginated dispute-resolution history" })
  @ApiParam({ name: 'address', description: 'Stellar Ed25519 public key of the arbiter' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default 20)' })
  @ApiResponse({ status: 200, description: 'Paginated dispute history (empty page when the arbiter has no history)' })
  getHistory(
    @Param() params: AddressParamDto,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.arbitersService.getHistory(params.address, page, limit);
  }
}
