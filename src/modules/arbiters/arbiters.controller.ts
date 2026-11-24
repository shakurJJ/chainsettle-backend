import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArbitersService } from './arbiters.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AddressParamDto } from './dto/address-param.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('arbiters')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('arbiters')
export class ArbitersController {
  constructor(
    private readonly arbitersService: ArbitersService,
    private readonly directory: ArbiterDirectoryService,
  ) {}

  /**
   * GET /arbiters — public directory of opted-in arbiters (#398).
   * Declared before the :address routes so the literal path is never captured as a param.
   */
  @Get()
  @ApiOperation({ summary: 'Browse arbiters: filter by minScore, availability and name/organization' })
  @ApiResponse({ status: 200, description: 'Paginated arbiter directory (public profile fields only)' })
  listDirectory(@Query() query: ArbiterDirectoryQueryDto) {
    return this.directory.list(query);
  }

  @Patch('me/directory')
  @ApiOperation({ summary: "Update the authenticated arbiter's directory listing, availability and organization" })
  @ApiResponse({ status: 200, description: 'Updated directory settings' })
  @ApiResponse({ status: 403, description: 'Caller is not an arbiter' })
  updateDirectoryProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateDirectoryProfileDto) {
    return this.directory.updateOwnProfile(userId, dto);
  }

  /**
   * PATCH /api/v1/arbiters/me/availability
   * Set or clear the caller's away period (#397). Arbiter role only.
   */
  @Patch('me/availability')
  @Roles(UserRole.ARBITER)
  @ApiOperation({ summary: 'Set or clear your arbiter away period' })
  @ApiResponse({ status: 200, description: 'Updated availability' })
  @ApiResponse({ status: 400, description: 'awayUntil is not in the future' })
  @ApiResponse({ status: 403, description: 'Arbiter role required' })
  setAvailability(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateAvailabilityDto) {
    return this.arbitersService.setAvailability(user.id, dto.awayUntil, dto.awayMessage);
  }

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
