import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { ReplayDeliveriesDto } from './dto/replay-deliveries.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Admin-only webhook delivery operations, kept separate from
 * WebhooksController so routes live under /admin/webhooks/* rather than
 * being nested under the owner-scoped /webhooks/* prefix.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/webhooks')
export class AdminWebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post(':id/deliveries/replay')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Replay every failed delivery for a webhook within a date range',
    description:
      'Re-enqueues every not-yet-delivered delivery (pending retry or permanently failed) ' +
      'for the given endpoint whose createdAt falls within [from, to], using the same ' +
      'retry logic as POST /webhooks/:id/deliveries/:deliveryId/retry. Deliveries outside ' +
      'the range, or already successful, are left untouched.',
  })
  @ApiParam({ name: 'id', description: 'Webhook endpoint id' })
  @ApiResponse({ status: 200, description: 'Summary count of deliveries queued for replay' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Webhook endpoint not found' })
  replay(@Param('id') id: string, @Body() dto: ReplayDeliveriesDto) {
    return this.webhooksService.replayFailedDeliveries(id, new Date(dto.from), new Date(dto.to));
  }
}
