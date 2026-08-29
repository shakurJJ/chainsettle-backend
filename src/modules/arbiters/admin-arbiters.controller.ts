import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ArbitersService } from './arbiters.service';
import { AddressParamDto } from './dto/address-param.dto';
import { ListArbitersQueryDto } from './dto/list-arbiters-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Admin-only arbiter roster/reputation operations, kept separate from
 * ArbitersController so routes live under /admin/arbiters/* rather than
 * being nested under the participant-facing /arbiters/* prefix.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/arbiters')
export class AdminArbitersController {
  constructor(private readonly arbitersService: ArbitersService) {}

  /**
   * GET /api/v1/admin/arbiters
   * Registered before :address-style routes are ever added to this
   * controller to avoid the literal segment being captured as a param.
   */
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] List every known arbiter with its cached reputation summary' })
  @ApiResponse({ status: 200, description: 'Every distinct arbiter address ever assigned to a shipment, with reputation' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  async list(@Query() query: ListArbitersQueryDto) {
    const addresses = await this.arbitersService.listKnownArbiterAddresses();
    const arbiters = await Promise.all(
      addresses.map((address) => this.arbitersService.getReputation(address)),
    );

    if (query.sortBy) {
      const field = query.sortBy;
      arbiters.sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0));
    }

    return arbiters;
  }

  @Post(':address/reputation/recompute')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "[Admin] Force an on-demand refresh of an arbiter's cached reputation" })
  @ApiParam({ name: 'address', description: 'Stellar Ed25519 public key of the arbiter' })
  @ApiResponse({ status: 200, description: 'Fresh reputation snapshot, now cached' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  recompute(@Param() params: AddressParamDto) {
    return this.arbitersService.recompute(params.address);
  }
}
