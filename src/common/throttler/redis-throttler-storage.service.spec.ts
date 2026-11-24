import Redis from "ioredis";
import { RedisThrottlerStorageService } from "./redis-throttler-storage.service";

jest.mock("ioredis", () => ({ __esModule: true, default: jest.fn() }));

describe("RedisThrottlerStorageService", () => {
  const redisClient = {
    on: jest.fn(),
    quit: jest.fn(),
    multi: jest.fn(),
    pexpire: jest.fn(),
  };
  const multi = {
    incr: jest.fn(),
    pttl: jest.fn(),
    exec: jest.fn(),
  };
  let service: RedisThrottlerStorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    (Redis as unknown as jest.Mock).mockImplementation(() => redisClient);
    redisClient.multi.mockReturnValue(multi);
    redisClient.pexpire.mockResolvedValue(1);
    multi.incr.mockReturnThis();
    multi.pttl.mockReturnThis();
    service = new RedisThrottlerStorageService({
      get: jest.fn().mockReturnValue("redis://unused"),
    } as any);
  });

  it("sets a fixed-window TTL for a new key and returns hits with seconds remaining", async () => {
    multi.exec.mockResolvedValue([
      [null, 1],
      [null, -1],
    ]);

    await expect(service.increment("route-a:user-1", 10_000)).resolves.toEqual({
      totalHits: 1,
      timeToExpire: 10,
    });

    expect(multi.incr).toHaveBeenCalledWith("throttle:route-a:user-1");
    expect(multi.pttl).toHaveBeenCalledWith("throttle:route-a:user-1");
    expect(redisClient.pexpire).toHaveBeenCalledWith(
      "throttle:route-a:user-1",
      10_000,
    );
  });

  it("preserves an existing TTL and rounds remaining milliseconds up to seconds", async () => {
    multi.exec.mockResolvedValue([
      [null, 4],
      [null, 1_501],
    ]);

    await expect(service.increment("route-a:user-1", 10_000)).resolves.toEqual({
      totalHits: 4,
      timeToExpire: 2,
    });

    expect(redisClient.pexpire).not.toHaveBeenCalled();
  });

  it("isolates counters by the full route key", async () => {
    multi.exec.mockResolvedValue([
      [null, 1],
      [null, 5_000],
    ]);

    await service.increment("route-a:user-1", 10_000);
    await service.increment("route-b:user-1", 10_000);

    expect(multi.incr.mock.calls).toEqual([
      ["throttle:route-a:user-1"],
      ["throttle:route-b:user-1"],
    ]);
    expect(multi.pttl.mock.calls).toEqual([
      ["throttle:route-a:user-1"],
      ["throttle:route-b:user-1"],
    ]);
  });

  it("returns the over-limit hit count so the throttler can reject the request", async () => {
    multi.exec.mockResolvedValue([
      [null, 6],
      [null, 3_000],
    ]);

    await expect(service.increment("route-a:user-1", 10_000)).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 3,
    });
  });

  it("fails open with zero hits when Redis commands fail", async () => {
    multi.exec.mockRejectedValue(new Error("Redis unavailable"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(service.increment("route-a:user-1", 10_000)).resolves.toEqual({
      totalHits: 0,
      timeToExpire: 0,
    });
  });
});
