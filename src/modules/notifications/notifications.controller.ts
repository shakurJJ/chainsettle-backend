import { Controller, Get, Post, Patch, Param, Query, Body, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

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
  ) {
    return this.notificationsService.findForUser(userId, unreadOnly, page, limit);
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

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences for the authenticated user' })
  getPreferences(@CurrentUser('id') userId: string) {
    return this.notificationsService.getOrCreatePreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification preferences (partial merge)' })
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @Post('test')
  @Throttle({ default: { limit: 1, ttl: 5 * 60 * 1000 } })
  @ApiOperation({ summary: 'Send a test notification to yourself' })
  sendTestNotification(@CurrentUser('id') userId: string) {
    return this.notificationsService.sendTestNotification(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single notification by ID' })
  async findOne(@Param('id') id: string, @CurrentUser('id') userId: string) {
    const notification = await this.notificationsService.findOne(userId, id);
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }
}
