import { AdminDashboardService } from "./admin-dashboard.service";

describe("AdminDashboardService", () => {
  const prisma = {
    shipment: { count: jest.fn() },
    webhookDelivery: { count: jest.fn() },
    eventCursor: { findUnique: jest.fn() },
  };
  const redis = { get: jest.fn() };
  const tokenRegistry = { findByAddress: jest.fn(), listTokens: jest.fn() };
  const fxRate = { getUsdRate: jest.fn() };
  let service: AdminDashboardService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminDashboardService(
      prisma as any,
      redis as any,
      tokenRegistry as any,
      fxRate as any,
    );
  });

  it("aggregates shipment and webhook counts and calculates event poller lag", async () => {
    prisma.shipment.count.mockResolvedValue(12);
    prisma.webhookDelivery.count.mockResolvedValue(2);
    prisma.eventCursor.findUnique.mockResolvedValue({
      lastProcessedLedger: 1_000,
    });
    redis.get.mockResolvedValue("1025");

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      activeShipments: 12,
      failedWebhookCount: 2,
      eventPollerLedger: 1_000,
      eventPollerLag: 25,
    });
    expect(snapshot.timestamp).toEqual(expect.any(String));
    expect(redis.get).toHaveBeenCalledWith("chainsettle:stellar:latest-ledger");
  });

  it("returns zero counts and null poller values for an empty database", async () => {
    prisma.shipment.count.mockResolvedValue(0);
    prisma.webhookDelivery.count.mockResolvedValue(0);
    prisma.eventCursor.findUnique.mockResolvedValue(null);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      activeShipments: 0,
      failedWebhookCount: 0,
      eventPollerLedger: null,
      eventPollerLag: null,
    });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("falls back to zero counts and a null lag when dependencies fail or return invalid data", async () => {
    prisma.shipment.count.mockRejectedValue(new Error("database unavailable"));
    prisma.webhookDelivery.count.mockRejectedValue(
      new Error("database unavailable"),
    );
    prisma.eventCursor.findUnique.mockResolvedValue({
      lastProcessedLedger: 1_000,
    });
    redis.get.mockResolvedValue("not-a-ledger");

    await expect(service.getSnapshot()).resolves.toMatchObject({
      activeShipments: 0,
      failedWebhookCount: 0,
      eventPollerLedger: 1_000,
      eventPollerLag: null,
    });
  });

  it("keeps the lag null if Redis cannot provide the current ledger", async () => {
    prisma.shipment.count.mockResolvedValue(1);
    prisma.webhookDelivery.count.mockResolvedValue(0);
    prisma.eventCursor.findUnique.mockResolvedValue({
      lastProcessedLedger: 1_000,
    });
    redis.get.mockRejectedValue(new Error("Redis unavailable"));

    await expect(service.getSnapshot()).resolves.toMatchObject({
      eventPollerLedger: 1_000,
      eventPollerLag: null,
    });
  });
});
