import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CalendarService } from './calendar.service';
import { MilestonesService } from './milestones.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * Per-user milestone calendar subscription.
 *
 * The feed itself is public and authenticated by a signed token in the query
 * string: calendar applications subscribe by URL and cannot send an
 * Authorization header. The token identifies its owner and is verified before
 * any milestone is read, so a feed only ever contains shipments its owner
 * participates in.
 */
@ApiTags('milestones')
@Controller('users/me/milestones')
export class UserCalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly milestones: MilestonesService,
  ) {}

  /**
   * GET /api/v1/users/me/milestones/upcoming?days=14&includeOverdue=false
   * Milestones due soon across every ACTIVE shipment the caller participates in (#395).
   */
  @Get('upcoming')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List your milestones due in the next N days across all shipments' })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'Window in days (1-90, default 14)' })
  @ApiQuery({ name: 'includeOverdue', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Upcoming milestones sorted by dueAt ascending' })
  @ApiResponse({ status: 400, description: 'days out of range' })
  getUpcoming(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('includeOverdue') includeOverdue?: string,
  ) {
    const window = days === undefined ? 14 : Number(days);
    if (!Number.isInteger(window) || window < 1 || window > 90) {
      throw new BadRequestException('days must be an integer between 1 and 90');
    }
    const callerAddress: string = user?.stellarAddress ?? user?.sub;
    return this.milestones.getUpcomingForUser(callerAddress, window, includeOverdue === 'true');
  }

  /**
   * GET /api/v1/users/me/milestones/calendar-token
   * Mint the caller a subscription token and the URL to subscribe with.
   */
  @Get('calendar-token')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a subscription token for your milestone calendar feed' })
  @ApiResponse({ status: 200, description: 'Subscription token and feed path' })
  getCalendarToken(@CurrentUser() user: AuthenticatedUser) {
    const token = this.calendar.issueToken(user.id);
    return {
      token,
      feedPath: `/api/v1/users/me/milestones/calendar.ics?token=${token}`,
      note:
        'Treat this URL as a secret. Anyone holding it can read your milestone ' +
        'due dates. Rotating CALENDAR_FEED_SECRET revokes all issued tokens.',
    };
  }

  /**
   * GET /api/v1/users/me/milestones/calendar.ics?token=...
   * iCalendar feed of milestone due dates across every shipment the token
   * owner participates in.
   */
  @Get('calendar.ics')
  @Public()
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @ApiOperation({ summary: 'Subscribe to your milestone due dates as an iCalendar feed' })
  @ApiResponse({ status: 200, description: 'iCalendar document' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async getUserCalendar(@Query('token') token: string, @Res() res: Response) {
    const userId = this.calendar.verifyToken(token);
    const body = await this.calendar.renderUserCalendar(userId);

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="chainsettle-milestones.ics"',
    );
    res.send(body);
  }
}
