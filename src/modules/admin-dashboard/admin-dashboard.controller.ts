import {
  Controller,
  Get,
  Logger,
  UseGuards,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminDashboardService } from './admin-dashboard.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/dashboard')
export class AdminDashboardController {
  private readonly logger = new Logger(AdminDashboardController.name);

  constructor(
    private readonly dashboard: AdminDashboardService,
    private readonly config: ConfigService,
  ) {}

  /**
   * GET /api/v1/admin/dashboard/realtime
   *
   * Server-Sent Events stream that pushes periodic platform metric snapshots.
   * Push interval is configurable via ADMIN_DASHBOARD_SSE_INTERVAL_MS (default 5 000 ms).
   * Clients must be authenticated as ADMIN.
   * Closing the connection cleans up the server-side interval automatically
   * (the Observable subscription is torn down by NestJS when the response closes).
   */
  @Get('realtime')
  @Roles(UserRole.ADMIN)
  @Sse()
  @ApiOperation({
    summary: '[Admin] SSE stream of live platform metrics',
    description:
      'Streams periodic snapshots of active shipments, event poller lag, and failed webhook count. ' +
      'Uses Server-Sent Events — no client re-polling required. ' +
      'Push interval is controlled by ADMIN_DASHBOARD_SSE_INTERVAL_MS env var (default 5000 ms).',
  })
  @ApiResponse({ status: 200, description: 'SSE stream of DashboardSnapshot objects' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  realtimeDashboard(): Observable<MessageEvent> {
    const intervalMs = this.config.get<number>('ADMIN_DASHBOARD_SSE_INTERVAL_MS', 5_000);

    return new Observable<MessageEvent>((subscriber) => {
      const push = () => {
        this.dashboard
          .getSnapshot()
          .then((snapshot) => {
            if (!subscriber.closed) {
              subscriber.next({ data: snapshot } as MessageEvent);
            }
          })
          .catch((err: Error) => {
            this.logger.error(`Dashboard snapshot failed: ${err.message}`);
          });
      };

      // Emit immediately on connect, then on each tick
      push();
      const timer = setInterval(push, intervalMs);

      return () => {
        clearInterval(timer);
        this.logger.debug('SSE client disconnected — interval cleared');
      };
    });
  }
}
