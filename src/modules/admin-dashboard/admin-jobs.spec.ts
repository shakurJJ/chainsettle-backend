import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ExecutionContext } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { UserRole } from "@prisma/client";
import { AdminDashboardService } from "./admin-dashboard.service";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { PrismaService } from "../../common/prisma/prisma.service";
import { RedisService } from "../../common/redis/redis.service";
import { TokenRegistryService } from "../../common/token-registry/token-registry.service";
import { FxRateService } from "../../common/fx/fx-rate.service";
import { ConfigService } from "@nestjs/config";
import { RolesGuard } from "../../common/guards/roles.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import {
  getJobRedisKey,
  JobRunRecord,
} from "../../common/jobs/job-tracker.util";

describe("Admin Jobs (#533)", () => {
  let service: AdminDashboardService;
  let controller: AdminDashboardController;
  let mockRedis: { getJson: jest.Mock; setJson: jest.Mock };
  let mockSchedulerRegistry: { getCronJobs: jest.Mock };

  beforeEach(async () => {
    mockRedis = {
      getJson: jest.fn(),
      setJson: jest.fn(),
    };

    const mockCronJob1 = {
      cronTime: { source: "0 2 * * *" },
      nextDate: jest.fn().mockReturnValue({
        toISO: () => "2026-10-20T02:00:00.000Z",
      }),
    };

    const mockCronJob2 = {
      cronTime: { source: "*/5 * * * *" },
      nextDate: jest.fn().mockReturnValue({
        toISO: () => "2026-10-19T18:35:00.000Z",
      }),
    };

    const cronMap = new Map<string, any>();
    cronMap.set("notification-cleanup", mockCronJob1);
    cronMap.set("shipment-reminder", mockCronJob2);

    mockSchedulerRegistry = {
      getCronJobs: jest.fn().mockReturnValue(cronMap),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminDashboardController],
      providers: [
        AdminDashboardService,
        { provide: PrismaService, useValue: {} },
        { provide: RedisService, useValue: mockRedis },
        { provide: TokenRegistryService, useValue: {} },
        { provide: FxRateService, useValue: {} },
        { provide: SchedulerRegistry, useValue: mockSchedulerRegistry },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdminDashboardService>(AdminDashboardService);
    controller = module.get<AdminDashboardController>(AdminDashboardController);
  });

  describe("AdminDashboardService.getScheduledJobs()", () => {
    it("returns all jobs with name, schedule, lastRunAt, lastResult, nextRunAt, and durationMs", async () => {
      mockRedis.getJson.mockImplementation(async (key: string) => {
        if (key === getJobRedisKey("notification-cleanup")) {
          return {
            name: "notification-cleanup",
            lastRunAt: "2026-10-19T02:00:00.000Z",
            lastResult: "SUCCESS",
            durationMs: 350,
          } as JobRunRecord;
        }
        return null;
      });

      const jobs = await service.getScheduledJobs();

      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toEqual({
        name: "notification-cleanup",
        schedule: "0 2 * * *",
        lastRunAt: "2026-10-19T02:00:00.000Z",
        lastResult: "SUCCESS",
        durationMs: 350,
        nextRunAt: "2026-10-20T02:00:00.000Z",
      });
      expect(jobs[1]).toEqual({
        name: "shipment-reminder",
        schedule: "*/5 * * * *",
        lastRunAt: null,
        lastResult: null,
        durationMs: null,
        nextRunAt: "2026-10-19T18:35:00.000Z",
      });
    });

    it("returns jobs sorted deterministically by name", async () => {
      const cronMap = new Map<string, any>();
      cronMap.set("zebra-job", {
        cronTime: { source: "0 0 * * *" },
        nextDate: () => null,
      });
      cronMap.set("alpha-job", {
        cronTime: { source: "0 0 * * *" },
        nextDate: () => null,
      });
      mockSchedulerRegistry.getCronJobs.mockReturnValue(cronMap);
      mockRedis.getJson.mockResolvedValue(null);

      const jobs = await service.getScheduledJobs();

      expect(jobs.map((j) => j.name)).toEqual(["alpha-job", "zebra-job"]);
    });
  });

  describe("GET /admin/jobs endpoint authorization & controller", () => {
    it("controller delegates to service.getScheduledJobs()", async () => {
      const spy = jest.spyOn(service, "getScheduledJobs").mockResolvedValue([]);
      const result = await controller.getScheduledJobs();
      expect(spy).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("has ADMIN role metadata attached to getScheduledJobs", () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[]>(
        ROLES_KEY,
        controller.getScheduledJobs,
      );
      expect(roles).toBeDefined();
      expect(roles).toContain(UserRole.ADMIN);
    });

    it("RolesGuard allows ADMIN and rejects non-admin users with 403", () => {
      const reflector = new Reflector();
      const guard = new RolesGuard(reflector);

      const makeContext = (role?: UserRole): ExecutionContext =>
        ({
          getHandler: () => controller.getScheduledJobs,
          getClass: () => AdminDashboardController,
          switchToHttp: () => ({
            getRequest: () => ({ user: role ? { id: "u1", role } : undefined }),
          }),
        }) as unknown as ExecutionContext;

      expect(guard.canActivate(makeContext(UserRole.ADMIN))).toBe(true);
      expect(guard.canActivate(makeContext(UserRole.BUYER))).toBe(false);
      expect(guard.canActivate(makeContext(UserRole.SUPPLIER))).toBe(false);
      expect(guard.canActivate(makeContext(undefined))).toBe(false);
    });
  });
});
