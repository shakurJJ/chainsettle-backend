import {
  Controller,
  Get,
  Header,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

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
  constructor(private readonly calendar: CalendarService) {}

  /**
   * GET /api/v1/users/me/milestones/calendar-token
   * Mint the caller a subscription token and the URL to subscribe with.
   */
  @Get('calendar-token')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a subscription token for your milestone calendar feed' })
  @ApiResponse({ status: 200, description: 'Subscription token and feed path' })
  getCalendarToken(@CurrentUser() user: any) {
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
