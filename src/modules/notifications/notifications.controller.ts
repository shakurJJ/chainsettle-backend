import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, NotFoundException, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { WebPushService } from './web-push.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { RegisterWebPushDto } from './dto/register-web-push.dto';
import { SnoozeNotificationDto } from './dto/snooze-notification.dto';
import { TelegramService } from './telegram.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly webPushService: WebPushService,
    private readonly telegramService: TelegramService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get notifications for the authenticated user' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentUser('id') userId: string,
    @Query('unreadOnly') unreadOnly?: boolean,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('groupBy') groupBy?: 'shipment' | 'none',
  ) {
    return this.notificationsService.findForUser(userId, unreadOnly, page, limit, groupBy);
  }

  @Post('read-by-shipment/:shipmentId')
  @ApiOperation({ summary: 'Mark all notifications for a shipment as read' })
  async markReadByShipment(
    @CurrentUser('id') userId: string,
    @Param('shipmentId') shipmentId: string,
  ) {
    return this.notificationsService.markReadByShipment(userId, shipmentId);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  markRead(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notificationsService.markRead(id, userId);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllRead(userId);
  }

  @Delete('read')
  @ApiOperation({ summary: 'Delete all read notifications for the authenticated user' })
  deleteAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.deleteAllRead(userId);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences for the authenticated user' })
  getPreferences(@CurrentUser('id') userId: string) {
    return this.notificationsService.getPreferencesResponse(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification preferences (partial merge)' })
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @Post('telegram/link')
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Generate a one-time Telegram account-linking URL' })
  createTelegramLink(@CurrentUser('id') userId: string) {
    return this.telegramService.createLink(userId);
  }

  @Delete('telegram/link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlink the Telegram account from notifications' })
  unlinkTelegram(@CurrentUser('id') userId: string) {
    return this.telegramService.unlink(userId);
  }

  @Post('test')
  @Throttle({ default: { limit: 1, ttl: 5 * 60 * 1000 } })
  @ApiOperation({ summary: 'Send a test notification to yourself' })
  sendTestNotification(@CurrentUser('id') userId: string) {
    return this.notificationsService.sendTestNotification(userId);
  }

  @Post('teams/test')
  @Throttle({ default: { limit: 1, ttl: 5 * 60 * 1000 } })
  @ApiOperation({ summary: 'Test the configured Microsoft Teams webhook' })
  sendTeamsTestNotification(@CurrentUser('id') userId: string) {
    return this.notificationsService.sendTeamsTestNotification(userId);
  }

  @Get('digest-preview')
  @ApiOperation({ summary: 'Preview the next scheduled email digest' })
  async getDigestPreview(@CurrentUser('id') userId: string) {
    const digest = await this.notificationsService.buildDigest(userId);
    return digest || { subject: '', html: '' };
  }

  // ── One-Click Unsubscribe (RFC 8058) ─────────────────────────────────────────

  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One-click unsubscribe from email notifications (RFC 8058)',
    description: 'Accepts a signed token via query parameter or request body and opts the user out of the corresponding notification email type.',
  })
  async unsubscribe(
    @Query('token') queryToken?: string,
    @Body() body?: { token?: string },
  ) {
    const token = queryToken || body?.token;
    if (!token) {
      throw new BadRequestException('Unsubscribe token is required');
    }
    return this.notificationsService.unsubscribe(token);
  }

  @Public()
  @Get('unsubscribe')
  @ApiOperation({
    summary: 'Browser link unsubscribe from email notifications',
    description: 'Accepts a signed token via query parameter for users clicking the unsubscribe link directly in an email footer.',
  })
  async unsubscribeGet(@Query('token') token?: string) {
    if (!token) {
      throw new BadRequestException('Unsubscribe token is required');
    }
    return this.notificationsService.unsubscribe(token);
  }

  // ── Snooze ─────────────────────────────────────────────────────────────────

  @Post(':id/snooze')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Snooze a notification until a given time',
    description:
      'Hides the notification from the default GET /notifications list until `until` passes. ' +
      'Once the snooze expires the notification reappears automatically as unread — ' +
      'the read/unread state is never changed by snoozing.',
  })
  async snooze(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SnoozeNotificationDto,
  ): Promise<void> {
    await this.notificationsService.snooze(userId, id, dto.until);
  }

  @Delete(':id/snooze')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel a snooze early',
    description: 'Clears the snoozedUntil timestamp so the notification reappears immediately.',
  })
  async unsnooze(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.notificationsService.unsnooze(userId, id);
  }

  // ── Single notification ─────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single notification by ID' })
  async findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    const notification = await this.notificationsService.findOne(userId, id);
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }
  // ── Web Push ────────────────────────────────────────────────────────────────

  @Public()
  @Get('web-push/public-key')
  @ApiOperation({ summary: 'Get the VAPID public key for web push subscription' })
  getWebPushPublicKey() {
    const key = this.webPushService.getPublicKey();
    return { publicKey: key };
  }

  @Post('web-push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register a browser push subscription for the authenticated user' })
  subscribeWebPush(@CurrentUser('id') userId: string, @Body() dto: RegisterWebPushDto) {
    return this.webPushService.subscribe(userId, dto);
  }

  @Delete('web-push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a browser push subscription' })
  unsubscribeWebPush(@CurrentUser('id') userId: string, @Body() dto: RegisterWebPushDto) {
    return this.webPushService.unsubscribe(userId, dto.endpoint);
  }
}
