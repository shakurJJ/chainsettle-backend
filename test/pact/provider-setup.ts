/**
 * Shared helper: bootstraps the NestJS application in test mode
 * and returns the base URL + a teardown function.
 *
 * Modules that require live infrastructure (Redis, Stellar, SMTP,
 * Prisma) are replaced with deterministic in-memory stubs so that
 * provider verification works in CI without external services.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { StellarService } from '../../src/common/stellar/stellar.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { ThrottlerExceptionFilter } from '../../src/common/filters/throttler-exception.filter';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';

// ─── Deterministic stubs ────────────────────────────────────────────────────

export const PROVIDER_STELLAR_ADDRESS = 'GABC1234PROVIDER0000000000000000000000000000000000000000000';
export const PROVIDER_USER_ID = 'provider-user-uuid-0001';

/** Minimal in-memory PrismaService mock for pact state setup. */
function buildPrismaMock() {
  const user = {
    id: PROVIDER_USER_ID,
    stellarAddress: PROVIDER_STELLAR_ADDRESS,
    email: 'provider@example.com',
    emailVerified: true,
    pendingEmail: null,
    name: 'Provider User',
    role: 'BUYER',
    deactivatedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const shipment = {
    id: 'shp-contract-test-001',
    buyerAddress: PROVIDER_STELLAR_ADDRESS,
    supplierAddress: 'GSUPPLIER000000000000000000000000000000000000000000000000',
    logisticsAddress: 'GLOGISTICS00000000000000000000000000000000000000000000000',
    arbiterAddress: 'GARBITER000000000000000000000000000000000000000000000000',
    tokenAddress: 'GBDEADBEEF000000000000000000000000000000000000000000000000',
    totalAmount: BigInt('100000000'),
    releasedAmount: BigInt('0'),
    status: 'ACTIVE',
    arbiterStatus: 'PENDING_ACCEPTANCE',
    tokenDecimals: 7,
    tokenSymbol: 'USDC',
    description: 'Contract test shipment',
    referenceNumber: 'REF-CT-001',
    metadata: null,
    tags: [],
    cancelledAt: null,
    refundTxHash: null,
    archivedAt: null,
    isDraft: false,
    txHash: 'abc123txhash',
    createdLedger: 1000,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    milestones: [
      {
        id: 'ms-001',
        shipmentId: 'shp-contract-test-001',
        milestoneIndex: 0,
        name: 'Milestone 1',
        paymentPercent: 100,
        proofHash: null,
        status: 'PENDING',
        paymentReleased: null,
        confirmedAt: null,
        dueAt: null,
        overdueNotifiedAt: null,
        overdueReminder3dAt: null,
        disputeEscalatedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    events: [],
    trackingUpdates: [],
    watchers: [],
  };

  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      findFirst: jest.fn().mockResolvedValue(user),
      upsert: jest.fn().mockResolvedValue(user),
      create: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue(user),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([user]),
    },
    shipment: {
      findUnique: jest.fn().mockResolvedValue(shipment),
      findFirst: jest.fn().mockResolvedValue(shipment),
      findMany: jest.fn().mockResolvedValue([shipment]),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue(shipment),
      update: jest.fn().mockResolvedValue(shipment),
    },
    milestone: {
      findMany: jest.fn().mockResolvedValue(shipment.milestones),
      findUnique: jest.fn().mockResolvedValue(shipment.milestones[0]),
      update: jest.fn().mockResolvedValue(shipment.milestones[0]),
    },
    notification: { create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    auditLog: { create: jest.fn() },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    webhookDelivery: { create: jest.fn() },
    apiKey: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    chainEvent: { findMany: jest.fn().mockResolvedValue([]) },
    trackingUpdate: { findMany: jest.fn().mockResolvedValue([]) },
    eventCursor: { upsert: jest.fn() },
    $transaction: jest.fn().mockImplementation((args) => Promise.all(args)),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([shipment]),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
}

function buildRedisMock() {
  const store = new Map<string, string>();
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, val: string) => { store.set(key, val); return Promise.resolve('OK'); }),
    setPx: jest.fn((key: string, val: string) => { store.set(key, val); return Promise.resolve('OK'); }),
    del: jest.fn((key: string) => { store.delete(key); return Promise.resolve(1); }),
    delByPrefix: jest.fn(() => Promise.resolve()),
    getJson: jest.fn(() => Promise.resolve(null)),
    setJson: jest.fn(() => Promise.resolve()),
  };
}

function buildStellarMock() {
  return {
    toHumanAmount: jest.fn((raw: bigint, decimals: number) =>
      (Number(raw) / 10 ** decimals).toFixed(7),
    ),
    simulateContractCall: jest.fn().mockResolvedValue(null),
    getHorizonServer: jest.fn(),
  };
}

// ─── App bootstrap ───────────────────────────────────────────────────────────

export interface ProviderSetup {
  app: INestApplication;
  baseUrl: string;
  jwtToken: string;
  teardown: () => Promise<void>;
}

export async function startProvider(port?: number): Promise<ProviderSetup> {
  const resolvedPort =
    port ??
    (process.env.PACT_PROVIDER_PORT ? parseInt(process.env.PACT_PROVIDER_PORT, 10) : 0);

  const prismaMock = buildPrismaMock();
  const redisMock = buildRedisMock();
  const stellarMock = buildStellarMock();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)
    .overrideProvider(RedisService)
    .useValue(redisMock)
    .overrideProvider(StellarService)
    .useValue(stellarMock)
    .compile();

  const app = moduleFixture.createNestApplication();

  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(), new ThrottlerExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  await app.init();

  const httpServer = app.getHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(resolvedPort, resolve));
  const actualPort: number = httpServer.address().port;
  const baseUrl = `http://localhost:${actualPort}`;

  // Generate a real JWT so the provider can authenticate requests in state handlers.
  const jwtService = moduleFixture.get(JwtService);
  const jwtToken = jwtService.sign({
    sub: PROVIDER_USER_ID,
    stellarAddress: PROVIDER_STELLAR_ADDRESS,
    role: 'BUYER',
  });

  return {
    app,
    baseUrl,
    jwtToken,
    teardown: () => app.close(),
  };
}
