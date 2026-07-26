import { Controller, Post, Get, Delete, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @ApiOperation({ summary: 'Register a webhook endpoint — returns plaintext secret once' })
  register(@CurrentUser('id') userId: string, @Body() dto: CreateWebhookDto) {
    return this.webhooksService.register(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the authenticated user's webhook endpoints" })
  findAll(@CurrentUser('id') userId: string) {
    return this.webhooksService.findForUser(userId);
  }

  @Get('event-types')
  @ApiOperation({ summary: 'List subscribable webhook event types' })
  getEventTypes(): string[] {
    return Object.values(NotificationType);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single webhook endpoint with a recent delivery summary' })
  @ApiResponse({ status: 404, description: 'Webhook endpoint not found' })
  findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.webhooksService.findOneWithSummary(userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.webhooksService.remove(id, userId);
  }

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually retry a failed webhook delivery' })
  @ApiResponse({ status: 200, description: 'Webhook delivery retried' })
  @ApiResponse({ status: 403, description: 'Only the endpoint owner can retry' })
  @ApiResponse({ status: 404, description: 'Webhook delivery not found' })
  retryDelivery(
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.webhooksService.retryDelivery(id, deliveryId, userId);
  }
}
