import { Controller, Get, Post, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ShipmentsService } from './shipments.service';
import { FindStuckShipmentsDto } from './dto/find-stuck-shipments.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Admin-only shipment operations. Kept in a separate controller (rather
 * than ShipmentsController) so routes live under /admin/shipments/* instead
 * of being nested under the /shipments/* participant-scoped prefix.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/shipments')
export class AdminShipmentsController {
  constructor(private readonly shipmentsService: ShipmentsService) {}

  /**
   * GET /api/v1/admin/shipments/stuck
   * Registered before :id-style routes are ever added to this controller
   * to avoid the literal "stuck" segment being captured as an :id param.
   */
  @Get('stuck')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Find ACTIVE shipments with no milestone activity for N+ days (admin only)' })
  @ApiResponse({ status: 200, description: 'Paginated list of stuck shipments, sorted by daysSinceActivity descending' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  findStuck(@Query() query: FindStuckShipmentsDto) {
    return this.shipmentsService.findStuckShipments(
      query.minDays ?? 14,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  /**
   * POST /api/v1/admin/shipments/:id/force-sync
   * Admin resync bypassing the participant ownership guard. Reuses the
   * same chain-read logic as POST /shipments/:id/sync and records an
   * audit log entry since this bypasses the normal ownership check.
   */
  @Post(':id/force-sync')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force sync a shipment from chain, bypassing participant guard (admin only)' })
  @ApiResponse({ status: 200, description: 'Shipment synced and returned' })
  @ApiResponse({ status: 403, description: 'Not authorized (admin only)' })
  @ApiResponse({ status: 404, description: 'Shipment not found' })
  forceSync(@Param('id') id: string, @CurrentUser() user: any) {
    return this.shipmentsService.adminForceSync(id, user.id, user.stellarAddress);
  }
}
