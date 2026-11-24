import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Body,
  Query,
  UseGuards,
  BadRequestException,
  Ip,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody, ApiResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { EventsService } from './events.service';
import { BackfillService } from './backfill.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { FindAllEventsDto } from './dto/find-all-events.dto';
import { RewindCursorDto } from './dto/rewind-cursor.dto';
import { StartBackfillDto } from './dto/start-backfill.dto';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly backfillService: BackfillService,
  ) {}

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
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Get a single failed DLQ event by ID' })
  async getFailedEventById(@Param('id') id: string) {
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
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Inspect event poller cursor lag and health' })
  getCursorStatus() {
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

  // ----------------------------------------------------------
  // ADMIN — Cursor rewind
  // ----------------------------------------------------------

  /**
   * POST /events/admin/cursor/rewind
   *
   * Moves the event-poller cursor back to `toLedger` so that all on-chain
   * events from that ledger onward are reprocessed.
   *
   * Safety guarantees:
   *  - Rejects ledgers beyond the RPC node retention window with 400.
   *  - Rejects future ledgers with 400.
   *  - Returns 409 when the distributed poller lock is held by another replica.
   *  - The action is written to the audit log with the provided reason.
   *  - Existing chain_events rows are upserted (update: {}) so no duplicates
   *    are created in the chain_events table.
   *
   * Admin-only.
   */
  @Post('admin/cursor/rewind')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Rewind the event-poller cursor to reprocess a ledger range',
    description:
      'Moves the Soroban event-poller cursor back to `toLedger`. ' +
      'All events from that ledger onward will be reprocessed. ' +
      'Refuses requests beyond the RPC retention window. ' +
      'The action is audited with the supplied reason.',
  })
  @ApiBody({ type: RewindCursorDto })
  @ApiResponse({
    status: 200,
    description: 'Cursor rewound successfully',
    schema: {
      example: {
        message: 'Event-poller cursor rewound successfully',
        previousLedger: 5_250_000,
        newLedger: 5_200_000,
        chainTip: 5_260_000,
        oldestAvailableLedger: 4_972_000,
      },
    },
  })
  @ApiResponse({ status: 400, description: 'toLedger is in the future or beyond the RPC retention window' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 409, description: 'Poller lock held by another replica — retry shortly' })
  async rewindCursor(
    @Body() dto: RewindCursorDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    const result = await this.eventsService.rewindCursor(
      dto.toLedger,
      { id: user?.id, stellarAddress: user?.stellarAddress },
      dto.reason,
      ip,
    );

    return {
      message: 'Event-poller cursor rewound successfully',
      ...result,
    };
  }

  // ----------------------------------------------------------
  // ADMIN — Ledger-range event backfill
  // ----------------------------------------------------------

  /**
   * POST /events/admin/backfill
   *
   * Kicks off a background job that fetches and reprocesses all contract
   * events in [fromLedger, toLedger].  The live poller cursor is not
   * affected — new events continue to be processed in parallel.
   *
   * Returns the created BackfillRun immediately (status: PENDING).
   * Poll GET /events/admin/backfill/:id for progress.
   *
   * Constraints:
   *  - Range must be ≤ 100 000 ledgers.
   *  - Range must be within the RPC node retention window.
   *  - Only one backfill may run at a time (409 if another is active).
   *
   * Admin-only.
   */
  @Post('admin/backfill')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: '[Admin] Start a ledger-range event backfill job',
    description:
      'Reprocesses all contract events in [fromLedger, toLedger] without ' +
      'touching the live poller cursor. Returns immediately with a BackfillRun ' +
      'record (status: PENDING). Poll GET /events/admin/backfill/:id for progress. ' +
      'Maximum range: 100 000 ledgers. One backfill at a time.',
  })
  @ApiBody({ type: StartBackfillDto })
  @ApiResponse({
    status: 202,
    description: 'Backfill job accepted — returns BackfillRun with status PENDING',
    schema: {
      example: {
        id: 'a1b2c3d4-...',
        status: 'PENDING',
        fromLedger: 5_100_000,
        toLedger: 5_200_000,
        processedCount: 0,
        errorCount: 0,
        currentLedger: null,
        errorSummary: null,
        startedAt: '2026-09-29T10:00:00.000Z',
        completedAt: null,
        initiatedBy: 'GADMIN...',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid range — out of bounds or exceeds 100k ledger limit' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 409, description: 'Another backfill job is already running' })
  async startBackfill(
    @Body() dto: StartBackfillDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.backfillService.startBackfill(
      dto.fromLedger,
      dto.toLedger,
      { id: user?.id, stellarAddress: user?.stellarAddress },
      ip,
    );
  }

  /**
   * GET /events/admin/backfill/:id
   *
   * Returns the current state of a backfill run, including progress counters
   * and a computed progressPct (0–100).
   *
   * Admin-only.
   */
  @Get('admin/backfill/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: '[Admin] Get progress of a backfill run',
    description:
      'Returns the BackfillRun record with a computed progressPct field. ' +
      'Poll this endpoint until status is COMPLETED or FAILED.',
  })
  @ApiResponse({
    status: 200,
    description: 'BackfillRun with progress info',
    schema: {
      example: {
        id: 'a1b2c3d4-...',
        status: 'RUNNING',
        fromLedger: 5_100_000,
        toLedger: 5_200_000,
        processedCount: 42,
        errorCount: 1,
        currentLedger: 5_101_000,
        progressPct: 1,
        totalLedgers: 100_001,
        errorSummary: [{ ledger: 5_100_500, txHash: 'abc...', eventName: 'milestone_confirmed', error: '...' }],
        startedAt: '2026-09-29T10:00:00.000Z',
        completedAt: null,
        initiatedBy: 'GADMIN...',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Backfill run not found' })
  async getBackfillRun(@Param('id') id: string) {
    return this.backfillService.getBackfillRun(id);
  }
}
