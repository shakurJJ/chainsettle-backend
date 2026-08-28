import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { FindAllEventsDto } from './dto/find-all-events.dto';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  @ApiOperation({ summary: 'List on-chain events with optional shipment, ledger range, and topic filters' })
  findAll(@Query() query: FindAllEventsDto) {
    if (query.startLedger && query.endLedger && query.startLedger > query.endLedger) {
      throw new BadRequestException('startLedger sequence boundary cannot be greater than endLedger sequence boundary');
    }

    return this.eventsService.findAll(query);
  }

  // ----------------------------------------------------------
  // ADMIN — Dead-letter queue management
  // ----------------------------------------------------------

  @Get('admin/failed-events')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] List unresolved failed events (DLQ)' })
  getFailedEvents(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.eventsService.getAdminFailedEvents(page, limit);
  }

  @Get('admin/failed-events/:id')
  @ApiOperation({ summary: '[Admin] Get a single failed DLQ event by ID' })
  async getFailedEventById(@Param('id') id: string, @CurrentUser() user: any) {
    this.requireAdmin(user);
    try {
      return await this.eventsService.getFailedEventById(id);
    } catch (error) {
      if ((error as any).code === 'P2025') {
        throw new NotFoundException(`Failed event ${id} not found`);
      }
      throw error;
    }
  }

  @Get('admin/cursor')
  @ApiOperation({ summary: '[Admin] Inspect event poller cursor lag and health' })
  getCursorStatus(@CurrentUser() user: any) {
    this.requireAdmin(user);
    return this.eventsService.getCursorStatus();
  }

  @Post('admin/failed-events/:id/retry')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Manually retry a failed event by ID' })
  async retryFailedEvent(@Param('id') id: string) {
    try {
      await this.eventsService.retryFailedEventById(id);
      return { message: `Failed event ${id} retried and resolved successfully` };
    } catch (error) {
      if ((error as any).code === 'P2025') {
        throw new NotFoundException(`Failed event ${id} not found`);
      }
      throw error;
    }
  }
}
