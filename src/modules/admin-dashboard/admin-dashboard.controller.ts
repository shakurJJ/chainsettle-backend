import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  Req,
  Logger,
  UseGuards,
  Sse,
  Query,
  Res,
  MessageEvent,
  Req,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { Observable } from "rxjs";
import { Request, Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { AdminDashboardService } from "./admin-dashboard.service";
import { VolumeReportQueryDto } from "./dto/volume-report-query.dto";
import { ScheduledJobDto } from "./dto/scheduled-job.dto";
import { TriggerJobResponseDto } from "./dto/trigger-job-response.dto";
import { AdminJobsService } from "./admin-jobs.service";
import {
  AuthenticatedUser,
  CurrentUser,
} from "../../common/decorators/current-user.decorator";
import { MANUALLY_RUNNABLE_JOBS } from "../../common/jobs/job-locks";

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("admin")
export class AdminDashboardController {
  private readonly logger = new Logger(AdminDashboardController.name);

  constructor(
    private readonly dashboard: AdminDashboardService,
    private readonly jobs: AdminJobsService,
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
  @Get("dashboard/realtime")
  @Roles(UserRole.ADMIN)
  @Sse()
  @ApiOperation({
    summary: "[Admin] SSE stream of live platform metrics",
    description:
      "Streams periodic snapshots of active shipments, event poller lag, and failed webhook count. " +
      "Uses Server-Sent Events — no client re-polling required. " +
      "Push interval is controlled by ADMIN_DASHBOARD_SSE_INTERVAL_MS env var (default 5000 ms).",
  })
  @ApiResponse({
    status: 200,
    description: "SSE stream of DashboardSnapshot objects",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Admin access required" })
  realtimeDashboard(): Observable<MessageEvent> {
    const intervalMs = this.config.get<number>(
      "ADMIN_DASHBOARD_SSE_INTERVAL_MS",
      5_000,
    );

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
        this.logger.debug("SSE client disconnected — interval cleared");
      };
    });
  }

  /**
   * GET /api/v1/admin/reports/volume
   *
   * Shipment volume time series report grouped by interval.
   */
  @Get("reports/volume")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "[Admin] Shipment volume time-series report" })
  @ApiResponse({
    status: 200,
    description: "Time-series volume report (JSON or CSV)",
  })
  @ApiResponse({ status: 400, description: "Invalid date range or parameter" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Admin access required" })
  async getVolumeReport(
    @Query() query: VolumeReportQueryDto,
    @Res() res: Response,
  ) {
    const result = await this.dashboard.getVolumeReport(query);
    if (query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="shipment-volume-report.csv"',
      );
      return res.send(result);
    }
    return res.json(result);
  }

  /**
   * GET /api/v1/admin/jobs
   *
   * Lists all scheduled cron jobs with schedule, last run result/duration, and next run time (#533).
   */
  @Get("jobs")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "[Admin] List scheduled cron jobs with last and next run times",
    description:
      "Gives admins a view of every cron job, schedule, when it last ran, whether it succeeded, and when it runs next.",
  })
  @ApiResponse({
    status: 200,
    description: "List of scheduled cron jobs",
    type: [ScheduledJobDto],
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Admin access required" })
  async getScheduledJobs(): Promise<ScheduledJobDto[]> {
    return this.dashboard.getScheduledJobs();
  }

  /**
   * POST /api/v1/admin/jobs/:name/run
   *
   * Runs an allowlisted cron job on demand (e.g. reconciliation after an incident).
   */
  @Post("jobs/:name/run")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "[Admin] Run an allowlisted cron job on demand",
    description:
      "Starts the job in the background and returns 202. Respects the job's Redis lock, " +
      "so a run that would overlap an in-flight scheduled run is rejected with 409. " +
      `Runnable jobs: ${MANUALLY_RUNNABLE_JOBS.join(", ")}.`,
  })
  @ApiResponse({
    status: 202,
    description: "Job run accepted",
    type: TriggerJobResponseDto,
  })
  @ApiResponse({ status: 400, description: "Job is not allowlisted for manual runs" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Admin access required" })
  @ApiResponse({ status: 404, description: "Job is not registered" })
  @ApiResponse({ status: 409, description: "Job is already running" })
  async runJob(
    @Param("name") name: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<TriggerJobResponseDto> {
    return this.jobs.triggerJob(name, {
      id: user?.id,
      stellarAddress: user?.stellarAddress,
      ipAddress: req.ip,
    });
  }
}
