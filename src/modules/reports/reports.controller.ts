import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('statements/:month')
  @ApiOperation({ summary: "Download the caller's monthly account statement (PDF)" })
  @ApiParam({ name: 'month', example: '2026-10', description: 'YYYY-MM' })
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'Statement PDF' })
  @ApiResponse({ status: 400, description: "Invalid month (YYYY-MM)" })
  async statement(
    @Param('month') month: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const pdf = await this.reports.getStatementPdf(user.stellarAddress, month);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="statement-${month}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(pdf);
  }
}
