import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
}
