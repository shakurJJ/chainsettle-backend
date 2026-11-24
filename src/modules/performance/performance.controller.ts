import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PerformanceService } from './performance.service';
import { PerformanceQueryDto } from './dto/performance-query.dto';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  /**
   * GET /api/v1/users/:stellarAddress/performance
   */
  @Get(':stellarAddress/performance')
  @ApiOperation({
    summary: 'Supplier / logistics track record',
    description:
      'On-time milestone rate, dispute rate, proof-to-confirmation time and completed volume. ' +
      'Cached per address for one hour. totalVolumeUsd is null unless the caller has shared a shipment with the address.',
  })
  @ApiResponse({ status: 200, description: 'Performance stats (zeros when the address has no history)' })
  @ApiResponse({ status: 400, description: 'Invalid address, role or since' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getPerformance(
    @Param('stellarAddress') stellarAddress: string,
    @Query() query: PerformanceQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.performance.getPerformance(
      stellarAddress,
      { stellarAddress: user?.stellarAddress ?? user?.sub, role: user?.role },
      query.role,
      query.since,
    );
  }
}
