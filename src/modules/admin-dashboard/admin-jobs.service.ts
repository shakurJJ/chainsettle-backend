import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { RedisService } from "../../common/redis/redis.service";
import { AuditLogService } from "../audit-logs/audit-log.service";
import {
  isManuallyRunnableJob,
  JOB_LOCK_KEYS,
  MANUALLY_RUNNABLE_JOBS,
} from "../../common/jobs/job-locks";
import { TriggerJobResponseDto } from "./dto/trigger-job-response.dto";

export interface JobTriggerActor {
  id?: string;
  stellarAddress?: string;
  ipAddress?: string;
}

/**
 * Lets admins run an allowlisted cron job on demand (e.g. reconciliation
 * after an incident) without restarting the app or waiting for the schedule.
 */
@Injectable()
export class AdminJobsService {
  private readonly logger = new Logger(AdminJobsService.name);

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly redis: RedisService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Fires the job's registered cron callback in the background.
   *
   * The job's own Redis lock is checked first so an in-flight scheduled run
   * yields 409. The job still acquires that lock itself when it starts, so
   * even if a scheduled tick wins the narrow race between this check and the
   * manual run starting, the two never execute concurrently.
   */
  async triggerJob(
    name: string,
    actor: JobTriggerActor,
  ): Promise<TriggerJobResponseDto> {
    if (!isManuallyRunnableJob(name)) {
      throw new BadRequestException(
        `Job '${name}' cannot be run manually. Allowed jobs: ${MANUALLY_RUNNABLE_JOBS.join(", ")}`,
      );
    }

    let cronJob: ReturnType<SchedulerRegistry["getCronJob"]>;
    try {
      cronJob = this.schedulerRegistry.getCronJob(name);
    } catch {
      throw new NotFoundException(`Job '${name}' is not registered`);
    }

    if (await this.redis.exists(JOB_LOCK_KEYS[name])) {
      throw new ConflictException(
        `Job '${name}' is already running — try again once it finishes`,
      );
    }

    const triggeredAt = new Date().toISOString();

    await this.auditLog.record({
      actorId: actor.id,
      actorAddress: actor.stellarAddress ?? "SYSTEM",
      action: "job.manual_run",
      resourceType: "CronJob",
      resourceId: name,
      metadata: { job: name, triggeredAt },
      ipAddress: actor.ipAddress,
    });

    this.logger.log(
      `Manual run of '${name}' triggered by ${actor.stellarAddress ?? "unknown"}`,
    );

    // Run outside the request so the caller gets 202 immediately. The
    // callbacks registered via @Cron / addCronJob handle their own errors and
    // record the result through runTrackedJob.
    setImmediate(() => {
      try {
        cronJob.fireOnTick();
      } catch (err: any) {
        this.logger.error(`Manual run of '${name}' failed to start: ${err.message}`);
      }
    });

    return { job: name, status: "accepted", triggeredAt };
  }
}
