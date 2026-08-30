import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiProperty,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

// ── Response-shape documentation classes (Swagger only) ────────────────────

class RetryStatusDto {
  @ApiProperty({
    enum: ['succeeded', 'pending_retry', 'permanently_failed', 'pending'],
    example: 'pending_retry',
    description:
      'succeeded — delivered OK; ' +
      'pending_retry — waiting for the next scheduled retry; ' +
      'permanently_failed — retries exhausted or non-retryable error; ' +
      'pending — initial attempt in flight',
  })
  state: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-08-27T10:35:00.000Z',
    description: 'ISO-8601 timestamp of the next scheduled retry, null when not applicable',
  })
  nextRetryAt: string | null;

  @ApiProperty({ example: 2 })
  attemptCount: number;
}

class DeliveryDetailDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id: string;

  @ApiProperty({ example: 'ep-id' })
  endpointId: string;

  @ApiProperty({ example: 'SHIPMENT_CREATED' })
  eventType: string;

  @ApiProperty({ example: { shipmentId: 'abc' } })
  payload: Record<string, unknown>;

  @ApiProperty({ nullable: true, example: 503 })
  statusCode: number | null;

  @ApiProperty({ nullable: true, example: 'Service Unavailable' })
  responseBody: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  deliveredAt: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  nextRetryAt: string | null;

  @ApiProperty({ example: 2 })
  attemptCount: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  permanentlyFailedAt: string | null;

  @ApiProperty({ type: RetryStatusDto })
  retryStatus: RetryStatusDto;
}

// ── Controller ──────────────────────────────────────────────────────────────

@ApiTags('webhooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @ApiOperation({ summary: 'Register a webhook endpoint — returns plaintext secret once' })
  @ApiResponse({ status: 201, description: 'Endpoint registered; secret shown once' })
  register(@CurrentUser('id') userId: string, @Body() dto: CreateWebhookDto) {
    return this.webhooksService.register(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the authenticated user's webhook endpoints" })
  @ApiResponse({ status: 200, description: 'Array of endpoint summaries' })
  findAll(@CurrentUser('id') userId: string) {
    return this.webhooksService.findForUser(userId);
  }

  @Post('bulk-test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Send a test ping to every active webhook owned by the caller",
    description:
      'Fans out a test ping to all active endpoints. Returns a per-endpoint ' +
      'result (success/failure + latency) — an unreachable endpoint does not ' +
      'prevent the others from being tested. Inactive endpoints are skipped.',
  })
  @ApiResponse({ status: 200, description: 'Per-endpoint test results' })
  bulkTest(@CurrentUser('id') userId: string) {
    return this.webhooksService.bulkTest(userId);
  }

  @Get('event-types')
  @ApiOperation({ summary: 'List all subscribable webhook event types' })
  @ApiResponse({ status: 200, type: [String] })
  getEventTypes(): string[] {
    return Object.values(NotificationType);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single webhook endpoint with a recent delivery summary' })
  @ApiResponse({ status: 200, description: 'Endpoint detail with delivery summary' })
  @ApiResponse({ status: 404, description: 'Webhook endpoint not found' })
  findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.webhooksService.findOneWithSummary(userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  @ApiResponse({ status: 200, description: 'Endpoint deleted' })
  @ApiResponse({ status: 404, description: 'Webhook endpoint not found' })
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.webhooksService.remove(id, userId);
  }

  @Get(':id/deliveries/failed')
  @ApiOperation({ summary: 'List only the failed deliveries for a webhook endpoint' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of failed deliveries' })
  @ApiResponse({ status: 404, description: 'Webhook endpoint not found' })
  getFailedDeliveries(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.webhooksService.getFailedDeliveries(userId, id, page, limit);
  }

  @Get(':id/deliveries/:deliveryId')
  @ApiOperation({ summary: 'Get full detail for a single webhook delivery' })
  @ApiResponse({
    status: 200,
    type: DeliveryDetailDto,
    description:
      'Full delivery record including retryStatus.nextRetryAt when a retry is scheduled',
  })
  @ApiResponse({ status: 404, description: 'Webhook delivery not found' })
  getDelivery(
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.webhooksService.getDelivery(userId, id, deliveryId);
  }

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually retry a failed webhook delivery',
    description:
      'Clears permanentlyFailedAt so the delivery can be re-attempted regardless ' +
      'of prior auto-retry exhaustion. The automatic retry scheduler will also ' +
      'pick up retryable failures without any manual intervention.',
  })
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
