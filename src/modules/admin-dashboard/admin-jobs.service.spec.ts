import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { UserRole } from "@prisma/client";
import { AdminJobsService } from "./admin-jobs.service";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import { JOB_LOCK_KEYS } from "../../common/jobs/job-locks";

describe("AdminJobsService (manual job trigger)", () => {
  let service: AdminJobsService;
  let cronJob: { fireOnTick: jest.Mock };
  let schedulerRegistry: { getCronJob: jest.Mock };
  let redis: { exists: jest.Mock };
  let auditLog: { record: jest.Mock };

  const actor = { id: "admin-1", stellarAddress: "GADMIN", ipAddress: "10.0.0.1" };

  beforeEach(() => {
    jest.useFakeTimers();
    cronJob = { fireOnTick: jest.fn() };
    schedulerRegistry = { getCronJob: jest.fn().mockReturnValue(cronJob) };
    redis = { exists: jest.fn().mockResolvedValue(false) };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    service = new AdminJobsService(
      schedulerRegistry as any,
      redis as any,
      auditLog as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("runs an allowlisted job in the background and returns an accepted result", async () => {
    const result = await service.triggerJob("reconciliation", actor);

    expect(result).toEqual({
      job: "reconciliation",
      status: "accepted",
      triggeredAt: expect.any(String),
    });
    expect(redis.exists).toHaveBeenCalledWith(JOB_LOCK_KEYS.reconciliation);
    // Not run inline — the request returns before the job executes
    expect(cronJob.fireOnTick).not.toHaveBeenCalled();

    jest.runAllTimers();
    expect(cronJob.fireOnTick).toHaveBeenCalledTimes(1);
  });

  it("records the manual run in the audit log", async () => {
    await service.triggerJob("late-delivery", actor);

    expect(auditLog.record).toHaveBeenCalledWith({
      actorId: "admin-1",
      actorAddress: "GADMIN",
      action: "job.manual_run",
      resourceType: "CronJob",
      resourceId: "late-delivery",
      metadata: { job: "late-delivery", triggeredAt: expect.any(String) },
      ipAddress: "10.0.0.1",
    });
  });

  it("returns 409 when the job's lock is held by an in-flight run", async () => {
    redis.exists.mockResolvedValue(true);

    await expect(service.triggerJob("reconciliation", actor)).rejects.toBeInstanceOf(
      ConflictException,
    );

    jest.runAllTimers();
    expect(cronJob.fireOnTick).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it("rejects jobs that are not allowlisted", async () => {
    await expect(service.triggerJob("webhook-retry-queue", actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(schedulerRegistry.getCronJob).not.toHaveBeenCalled();
  });

  it("returns 404 when an allowlisted job is not registered", async () => {
    schedulerRegistry.getCronJob.mockImplementation(() => {
      throw new Error("No Cron Job was found");
    });

    await expect(service.triggerJob("reconciliation", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("controller route is admin-only and responds 202", () => {
    const reflector = new Reflector();
    const handler = AdminDashboardController.prototype.runJob;

    expect(reflector.get<UserRole[]>(ROLES_KEY, handler)).toContain(UserRole.ADMIN);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.ACCEPTED);
  });
});
