import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportsService } from './reports.service';
import { AgingReportQueryDto } from './dto/aging-report-query.dto';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * GET /api/v1/reports/aging
   *
   * Receivables aging for the authenticated supplier: unreleased milestone
   * value bucketed by days past due, grouped by settlement token.
   */
  @Get('aging')
  @ApiOperation({
    summary: 'Receivables aging for the calling supplier',
    description:
      'Buckets the value of PENDING and PROOF_SUBMITTED milestones that are past their due date ' +
      'into 0-30, 31-60, 61-90 and 90+ day buckets, grouped by token. ' +
      'Only shipments where the caller is the supplier are included. ' +
      'Pass includeUsdTotal=true for a USD valuation of each token total.',
  })
  @ApiResponse({
    status: 200,
    description: 'Aging buckets per token (empty byToken when nothing is past due)',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getAgingReport(
    @Query() query: AgingReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reports.getAgingReport(user.stellarAddress ?? user.sub, {
      includeUsdTotal: query.includeUsdTotal === true,
    });
  }
}
