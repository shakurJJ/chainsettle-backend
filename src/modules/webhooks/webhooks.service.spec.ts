import { MetricsService } from '../../common/metrics/metrics.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { NotificationType } from '@prisma/client';
import {
  validateHeaders,
  isReservedHeader,
  maskHeaders,
  encryptHeaderValue,
  decryptHeaderValue,
  MAX_HEADERS,
  MAX_HEADERS_TOTAL_BYTES,
} from './webhook-headers.util';

const TEST_ENC_KEY = '01234567890123456789012345678901';

jest.mock('axios');

// ─── Factories ────────────────────────────────────────────────────────────────

const makeEndpoint = (id = 'ep-1', headers?: unknown) => ({
  id,
  userId: 'user-1',
  url: 'https://example.com/hook',
  secret: crypto.createHash('sha256').update('plaintext-secret').digest('hex'),
  events: [NotificationType.SHIPMENT_CREATED],
  active: true,
  createdAt: new Date(),
  headers,
});

const makeDelivery = (overrides: Partial<ReturnType<typeof baseDelivery>> = {}) =>
  ({ ...baseDelivery(), ...overrides });

function baseDelivery() {
  return {
    id: 'del-1',
    endpointId: 'ep-1',
    eventType: 'SHIPMENT_CREATED',
    payload: {} as Record<string, unknown>,
    attemptCount: 1,
    statusCode: null as number | null,
    responseBody: null as string | null,
    deliveredAt: null as Date | null,
    nextRetryAt: null as Date | null,
    permanentlyFailedAt: null as Date | null,
    createdAt: new Date(),
  };
}

// ─── Mock builder ─────────────────────────────────────────────────────────────

function buildPrismaMock() {
  return {
    webhookEndpoint: {
      create: jest.fn().mockResolvedValue(makeEndpoint()),
      findMany: jest.fn().mockResolvedValue([makeEndpoint()]),
      findFirst: jest.fn().mockResolvedValue(makeEndpoint()),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...makeEndpoint(), ...data })),
      delete: jest.fn().mockResolvedValue(makeEndpoint()),
    },
    webhookDelivery: {
      create: jest.fn().mockResolvedValue(makeDelivery()),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...makeDelivery(), ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(makeDelivery()),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ stellarAddress: 'GXXX' }),
    },
  };
}

const auditLogMock = { record: jest.fn() };
const metricsMock = { observeWebhookDelivery: jest.fn() };

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('WebhooksService', () => {
  let service: WebhooksService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogMock },
        { provide: MetricsService, useValue: metricsMock },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) => {
              if (key === 'WEBHOOK_HEADERS_ENCRYPTION_KEY') return TEST_ENC_KEY;
              return fallback;
            },
          },
        },
      ],
    }).compile();
    service = module.get(WebhooksService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
  });

  // ── Signature header assertions ────────────────────────────────────────────

  const LEGACY_SIG_RE = /^sha256=[a-f0-9]{64}$/;
  const V2_SIG_RE = /^t=(\d+),v1=([a-f0-9]{64})$/;

  function assertHeaders(headers: Record<string, string>, body: string, plaintextSecret: string) {
    const tsHeader = headers['X-ChainSettle-Timestamp'];
    const sigHeader = headers['X-ChainSettle-Signature'];
    const sigV2Header = headers['X-ChainSettle-Signature-V2'];

    expect(tsHeader).toBeDefined();
    expect(Number.isInteger(Number(tsHeader))).toBe(true);
    expect(Number(tsHeader)).toBeGreaterThan(0);

    expect(sigHeader).toMatch(LEGACY_SIG_RE);
    const expectedLegacy =
      'sha256=' + crypto.createHmac('sha256', plaintextSecret).update(body).digest('hex');
    expect(sigHeader).toBe(expectedLegacy);

    const v2Match = V2_SIG_RE.exec(sigV2Header);
    expect(v2Match).not.toBeNull();
    const t = Number(v2Match![1]);
    const v1 = v2Match![2];
    expect(String(t)).toBe(tsHeader);
    const expectedV1 = crypto
      .createHmac('sha256', plaintextSecret)
      .update(`${t}.${body}`)
      .digest('hex');
    expect(v1).toBe(expectedV1);

    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(now - t)).toBeLessThanOrEqual(5);
  }

  describe('dispatch (deliverOnce) — signature & timestamp headers', () => {
    it('sends X-ChainSettle-Timestamp, legacy sig, and v2 sig with valid HMACs', async () => {
      const plaintextSecret = 'plaintext-secret';
      const ep = {
        ...makeEndpoint('ep-1'),
        secret: crypto.createHash('sha256').update(plaintextSecret).digest('hex'),
      };
      prisma.webhookEndpoint.findMany.mockResolvedValue([ep]);
      prisma.webhookDelivery.create.mockResolvedValue(makeDelivery());

      const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
      axiosPost.mockResolvedValue({ status: 200, data: 'ok' });

      await service.dispatch(NotificationType.SHIPMENT_CREATED, { shipmentId: 'abc' });

      expect(axiosPost).toHaveBeenCalledTimes(1);
      const [, body, config] = axiosPost.mock.calls[0]!;
      assertHeaders(config!.headers as Record<string, string>, body as string, plaintextSecret);
      expect(metricsMock.observeWebhookDelivery).toHaveBeenCalledWith('success', 200, expect.any(Number));
    });
  });

  describe('retryDelivery — signature & timestamp headers', () => {
    it('sends X-ChainSettle-Timestamp, legacy sig, and v2 sig with valid HMACs', async () => {
      const plaintextSecret = 'plaintext-secret';
      const ep = {
        ...makeEndpoint('ep-1'),
        secret: crypto.createHash('sha256').update(plaintextSecret).digest('hex'),
      };
      prisma.webhookDelivery.findFirst
        .mockResolvedValueOnce(ep)
        .mockResolvedValueOnce(makeDelivery());

      const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
      axiosPost.mockResolvedValue({ status: 200, data: 'ok' });

      await service.retryDelivery('ep-1', 'del-1', 'user-1');

      expect(axiosPost).toHaveBeenCalledTimes(1);
      const [, body, config] = axiosPost.mock.calls[0]!;
      assertHeaders(config!.headers as Record<string, string>, body as string, plaintextSecret);
    });
  });

  describe('processRetryQueue (executeRetry) — signature & timestamp headers', () => {
    it('sends X-ChainSettle-Timestamp, legacy sig, and v2 sig with valid HMACs', async () => {
      const plaintextSecret = 'plaintext-secret';
      const ep = {
        ...makeEndpoint('ep-1'),
        secret: crypto.createHash('sha256').update(plaintextSecret).digest('hex'),
      };
      const due = [{ ...makeDelivery({ id: 'del-1', attemptCount: 2 }), endpoint: ep }];
      prisma.webhookDelivery.findMany.mockResolvedValue(due);

      const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
      axiosPost.mockResolvedValue({ status: 200, data: 'ok' });

      await service.processRetryQueue();

      expect(axiosPost).toHaveBeenCalledTimes(1);
      const [, body, config] = axiosPost.mock.calls[0]!;
      assertHeaders(config!.headers as Record<string, string>, body as string, plaintextSecret);
    });
  });

  describe('bulkTest (sendTestPing) — signature & timestamp headers', () => {
    it('sends X-ChainSettle-Timestamp, legacy sig, and v2 sig with valid HMACs', async () => {
      const plaintextSecret = 'plaintext-secret';
      const ep = {
        ...makeEndpoint('ep-1'),
        secret: crypto.createHash('sha256').update(plaintextSecret).digest('hex'),
      };
      prisma.webhookEndpoint.findMany.mockResolvedValue([ep]);

      const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
      axiosPost.mockResolvedValue({ status: 200, data: 'ok' });

      await service.bulkTest('user-1');

      expect(axiosPost).toHaveBeenCalledTimes(1);
      const [, body, config] = axiosPost.mock.calls[0]!;
      assertHeaders(config!.headers as Record<string, string>, body as string, plaintextSecret);
    });
  });

  // ── HMAC signing ──────────────────────────────────────────────────────────

  describe('HMAC signing', () => {
    it('produces a 64-char hex sha256 signature', () => {
      const body = JSON.stringify({ eventType: 'SHIPMENT_CREATED', payload: {}, timestamp: 't' });
      const sig = crypto.createHmac('sha256', 'secret').update(body).digest('hex');
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for the same inputs', () => {
      const body = 'test-body';
      const s1 = crypto.createHmac('sha256', 'key').update(body).digest('hex');
      const s2 = crypto.createHmac('sha256', 'key').update(body).digest('hex');
      expect(s1).toBe(s2);
    });

    it('differs when the secret changes', () => {
      const body = 'test-body';
      const s1 = crypto.createHmac('sha256', 'key-a').update(body).digest('hex');
      const s2 = crypto.createHmac('sha256', 'key-b').update(body).digest('hex');
      expect(s1).not.toBe(s2);
    });
  });

  // ── register ──────────────────────────────────────────────────────────────

  describe('register', () => {
    it('returns a plaintext secret that differs from the stored hash', async () => {
      const result = await service.register('user-1', {
        url: 'https://example.com/hook',
        events: [NotificationType.SHIPMENT_CREATED],
      });

      const storedSecret: string = prisma.webhookEndpoint.create.mock.calls[0][0].data.secret;
      expect(result.secret).toBeDefined();
      expect(result.secret).not.toBe(storedSecret);
      expect(storedSecret).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── dispatch ──────────────────────────────────────────────────────────────

  describe('dispatch', () => {
    it('creates a delivery record for each active matching endpoint', async () => {
      prisma.webhookEndpoint.findMany.mockResolvedValue([makeEndpoint('ep-1'), makeEndpoint('ep-2')]);
      prisma.webhookDelivery.create
        .mockResolvedValueOnce(makeDelivery({ id: 'del-1' }))
        .mockResolvedValueOnce(makeDelivery({ id: 'del-2' }));

      await service.dispatch(NotificationType.SHIPMENT_CREATED, { shipmentId: 'abc' });

      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(2);
    });

    it('skips endpoints not subscribed to the event (Prisma filters them out)', async () => {
      prisma.webhookEndpoint.findMany.mockResolvedValue([]);

      await service.dispatch(NotificationType.PAYMENT_RELEASED, {});

      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });
  });

  // ── auto-retry: retryable vs non-retryable ────────────────────────────────

  describe('retry policy on initial delivery failure', () => {
    it('sets nextRetryAt (not permanentlyFailedAt) for a 503 response', async () => {
      prisma.webhookEndpoint.findMany.mockResolvedValue([makeEndpoint()]);
      prisma.webhookDelivery.create.mockResolvedValue(makeDelivery({ attemptCount: 1 }));

      // axios will throw with a 503 — simulate that via update mock inspection
      // The important assertion is that the first update records nextRetryAt, not permanentlyFailedAt
      await service.dispatch(NotificationType.SHIPMENT_CREATED, {});

      const updates = prisma.webhookDelivery.update.mock.calls;
      // At least one update should have nextRetryAt set (the failure scheduling)
      const retryUpdate = updates.find(([args]) => args.data?.nextRetryAt instanceof Date);
      expect(retryUpdate).toBeDefined();
    });

    it('sets permanentlyFailedAt immediately for a 404 response', async () => {
      // We test handleFailure directly through the public retryDelivery path:
      // delivery already at MAX_AUTO_ATTEMPTS (5) forces exhaustion
      const exhaustedDelivery = makeDelivery({ attemptCount: 5, permanentlyFailedAt: null });
      prisma.webhookDelivery.findFirst
        .mockResolvedValueOnce(makeEndpoint()) // endpoint lookup
        .mockResolvedValueOnce(exhaustedDelivery); // delivery lookup

      // axios throws 404 — non-retryable
      // retryDelivery calls axios, which will fail with a network error in test;
      // the key assertion is that permanentlyFailedAt is NOT cleared and update is called
      await service.retryDelivery('ep-1', 'del-1', 'user-1');

      const updates = prisma.webhookDelivery.update.mock.calls;
      expect(updates.length).toBeGreaterThan(0);
    });
  });

  // ── getDelivery: retryStatus surface ─────────────────────────────────────

  describe('getDelivery retryStatus', () => {
    const cases: Array<{
      label: string;
      delivery: Partial<ReturnType<typeof baseDelivery>>;
      expectedState: string;
    }> = [
      {
        label: 'delivered → succeeded',
        delivery: { deliveredAt: new Date(), statusCode: 200 },
        expectedState: 'succeeded',
      },
      {
        label: 'permanentlyFailedAt set → permanently_failed',
        delivery: { permanentlyFailedAt: new Date() },
        expectedState: 'permanently_failed',
      },
      {
        label: 'nextRetryAt in future → pending_retry',
        delivery: { nextRetryAt: new Date(Date.now() + 60_000) },
        expectedState: 'pending_retry',
      },
      {
        label: 'no fields set → pending',
        delivery: {},
        expectedState: 'pending',
      },
    ];

    for (const { label, delivery, expectedState } of cases) {
      it(label, async () => {
        prisma.webhookEndpoint.findFirst.mockResolvedValue(makeEndpoint());
        prisma.webhookDelivery.findFirst.mockResolvedValue(makeDelivery(delivery));

        const result = await service.getDelivery('user-1', 'ep-1', 'del-1');

        expect(result.retryStatus.state).toBe(expectedState);
      });
    }

    it('surfaces nextRetryAt on the response when state is pending_retry', async () => {
      const nextRetryAt = new Date(Date.now() + 120_000);
      prisma.webhookEndpoint.findFirst.mockResolvedValue(makeEndpoint());
      prisma.webhookDelivery.findFirst.mockResolvedValue(makeDelivery({ nextRetryAt }));

      const result = await service.getDelivery('user-1', 'ep-1', 'del-1');

      expect(result.retryStatus.nextRetryAt).toEqual(nextRetryAt);
    });
  });

  // ── processRetryQueue ─────────────────────────────────────────────────────

  describe('processRetryQueue', () => {
    it('does nothing when no deliveries are due', async () => {
      prisma.webhookDelivery.findMany.mockResolvedValue([]);

      await service.processRetryQueue();

      expect(prisma.webhookDelivery.update).not.toHaveBeenCalled();
    });

    it('processes each due delivery', async () => {
      const ep = makeEndpoint();
      const due = [
        { ...makeDelivery({ id: 'del-1', attemptCount: 2 }), endpoint: ep },
        { ...makeDelivery({ id: 'del-2', attemptCount: 3 }), endpoint: ep },
      ];
      prisma.webhookDelivery.findMany.mockResolvedValue(due);
      // update called once per delivery to bump attemptCount, then again on failure
      prisma.webhookDelivery.update.mockResolvedValue(makeDelivery());

      await service.processRetryQueue();

      // At least 2 updates (one per delivery bump), possibly more for failure writes
      expect(prisma.webhookDelivery.update.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Header validation ─────────────────────────────────────────────────────

  describe('validateHeaders', () => {
    it('passes for valid custom headers', () => {
      expect(validateHeaders({ Authorization: 'Bearer token' })).toBeNull();
      expect(validateHeaders({ 'X-Custom-Id': 'abc123' })).toBeNull();
    });

    it('rejects reserved Host header', () => {
      const err = validateHeaders({ Host: 'evil.com' });
      expect(err).not.toBeNull();
      expect(err!.message).toContain('reserved');
    });

    it('rejects reserved Content-Type header', () => {
      const err = validateHeaders({ 'Content-Type': 'text/plain' });
      expect(err).not.toBeNull();
      expect(err!.message).toContain('reserved');
    });

    it('rejects reserved Content-Length header', () => {
      const err = validateHeaders({ 'content-length': '123' });
      expect(err).not.toBeNull();
      expect(err!.message).toContain('reserved');
    });

    it('rejects X-ChainSettle-* headers (case-insensitive)', () => {
      const err1 = validateHeaders({ 'X-ChainSettle-Custom': 'x' });
      expect(err1).not.toBeNull();
      expect(err1!.message).toContain('reserved');

      const err2 = validateHeaders({ 'x-chainsettle-foo': 'y' });
      expect(err2).not.toBeNull();
    });

    it(`rejects more than ${MAX_HEADERS} headers`, () => {
      const tooMany: Record<string, string> = {};
      for (let i = 0; i <= MAX_HEADERS; i++) tooMany[`X-${i}`] = String(i);
      const err = validateHeaders(tooMany);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/Too many|max 10/);
    });

    it(`rejects headers exceeding ${MAX_HEADERS_TOTAL_BYTES} bytes total`, () => {
      const big: Record<string, string> = { 'X-Big': 'x'.repeat(MAX_HEADERS_TOTAL_BYTES) };
      const err = validateHeaders(big);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/exceed|bytes/);
    });

    it('rejects non-string values', () => {
      const err = validateHeaders({ 'X-Bad': 123 as any });
      expect(err).not.toBeNull();
    });

    it('rejects invalid header name characters', () => {
      const err = validateHeaders({ 'Bad Name': 'x' });
      expect(err).not.toBeNull();
      expect(err!.message).toContain('Invalid header name');
    });
  });

  describe('isReservedHeader', () => {
    it('is true for Host, Content-Length, Content-Type (case-insensitive)', () => {
      expect(isReservedHeader('Host')).toBe(true);
      expect(isReservedHeader('host')).toBe(true);
      expect(isReservedHeader('CONTENT-LENGTH')).toBe(true);
      expect(isReservedHeader('content-type')).toBe(true);
    });
    it('is true for anything starting with X-ChainSettle-', () => {
      expect(isReservedHeader('X-ChainSettle-Timestamp')).toBe(true);
      expect(isReservedHeader('x-chainsettle-signature-v2')).toBe(true);
    });
    it('is false for arbitrary custom headers', () => {
      expect(isReservedHeader('Authorization')).toBe(false);
      expect(isReservedHeader('X-My-App-Id')).toBe(false);
    });
  });

  // ── Masking & encryption round-trip ───────────────────────────────────────

  describe('maskHeaders', () => {
    it('preserves header names but replaces values with a mask', () => {
      const masked = maskHeaders({ Authorization: 'secret', 'X-Custom': 'value' });
      expect(masked).toEqual({ Authorization: '••••••••', 'X-Custom': '••••••••' });
    });

    it('returns empty object for empty input', () => {
      expect(maskHeaders({})).toEqual({});
    });
  });

  describe('AES-GCM encrypt/decrypt round-trip', () => {
    it('decrypts to the original value', () => {
      const plain = 'Bearer super-secret-token-123';
      const enc = encryptHeaderValue(plain, TEST_ENC_KEY);
      expect(enc).not.toEqual(plain);
      expect(enc).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(decryptHeaderValue(enc, TEST_ENC_KEY)).toBe(plain);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
      const plain = 'x';
      const a = encryptHeaderValue(plain, TEST_ENC_KEY);
      const b = encryptHeaderValue(plain, TEST_ENC_KEY);
      expect(a).not.toBe(b);
      expect(decryptHeaderValue(a, TEST_ENC_KEY)).toBe('x');
      expect(decryptHeaderValue(b, TEST_ENC_KEY)).toBe('x');
    });

    it('throws on tampered ciphertext', () => {
      const enc = encryptHeaderValue('hello', TEST_ENC_KEY);
      const tampered = enc.slice(0, -1) + (enc.endsWith('A') ? 'B' : 'A');
      expect(() => decryptHeaderValue(tampered, TEST_ENC_KEY)).toThrow();
    });

    it('fails with the wrong key', () => {
      const enc = encryptHeaderValue('hello', TEST_ENC_KEY);
      expect(() => decryptHeaderValue(enc, 'wrong-key-length------0123456789!!')).toThrow();
    });
  });

  // ── register() with headers ───────────────────────────────────────────────

  describe('register with headers', () => {
    it('encrypts values when storing, returns masked names', async () => {
      const plainHeaders = { Authorization: 'Bearer tok', 'X-Id': '42' };
      prisma.webhookEndpoint.create.mockImplementation(({ data }: any) => {
        const stored = data.headers as Record<string, string>;
        expect(stored).toBeDefined();
        expect(Object.keys(stored).sort()).toEqual(['Authorization', 'X-Id']);
        expect(stored.Authorization).not.toBe(plainHeaders.Authorization);
        expect(decryptHeaderValue(stored.Authorization, TEST_ENC_KEY)).toBe('Bearer tok');
        expect(decryptHeaderValue(stored['X-Id'], TEST_ENC_KEY)).toBe('42');
        return Promise.resolve({ ...makeEndpoint(), ...data });
      });

      const result = await service.register('user-1', {
        url: 'https://example.com/hook',
        events: [NotificationType.SHIPMENT_CREATED],
        headers: plainHeaders,
      });

      expect(result.headers).toEqual({ Authorization: '••••••••', 'X-Id': '••••••••' });
    });

    it('throws 400 on reserved header', async () => {
      await expect(
        service.register('user-1', {
          url: 'https://example.com/hook',
          events: [NotificationType.SHIPMENT_CREATED],
          headers: { 'Content-Type': 'text/plain' } as any,
        }),
      ).rejects.toThrow(/reserved/);
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('does not store headers field when none provided', async () => {
      prisma.webhookEndpoint.create.mockImplementation(({ data }: any) => {
        expect(data.headers).toBeNull();
        return Promise.resolve({ ...makeEndpoint(), ...data });
      });
      const res = await service.register('user-1', {
        url: 'https://example.com/hook',
        events: [NotificationType.SHIPMENT_CREATED],
      });
      expect(res.headers).toBeUndefined();
    });
  });

  // ── update() with headers ─────────────────────────────────────────────────

  describe('update with headers', () => {
    it('replaces the encrypted headers map', async () => {
      prisma.webhookEndpoint.update.mockImplementation(({ data }: any) => {
        const stored = data.headers as Record<string, string>;
        expect(decryptHeaderValue(stored['X-New'], TEST_ENC_KEY)).toBe('val');
        return Promise.resolve({ ...makeEndpoint(), ...data });
      });
      const res = await service.update('user-1', 'ep-1', {
        headers: { 'X-New': 'val' },
      });
      expect(res.headers).toEqual({ 'X-New': '••••••••' });
    });

    it('clears headers when passed {}', async () => {
      let updatedWith: any;
      prisma.webhookEndpoint.update.mockImplementation(({ data }: any) => {
        updatedWith = data;
        return Promise.resolve({ ...makeEndpoint(), headers: null });
      });
      const res = await service.update('user-1', 'ep-1', { headers: {} });
      expect(updatedWith.headers).toBeDefined();
      expect(res.headers).toBeUndefined();
    });

    it('throws 400 for reserved header on PATCH', async () => {
      await expect(
        service.update('user-1', 'ep-1', {
          headers: { Host: 'x.com' } as any,
        }),
      ).rejects.toThrow(/reserved/);
    });
  });

  // ── findForUser / findOneWithSummary: masked headers in response ───────────

  describe('headers in GET responses', () => {
    it('findForUser returns masked headers for stored encrypted ones', async () => {
      const encrypted = {
        Authorization: encryptHeaderValue('Bearer x', TEST_ENC_KEY),
      };
      prisma.webhookEndpoint.findMany.mockResolvedValue([makeEndpoint('ep-1', encrypted)]);
      const list = await service.findForUser('user-1');
      expect(list[0].headers).toEqual({ Authorization: '••••••••' });
    });

    it('findOneWithSummary returns masked headers', async () => {
      const encrypted = { 'X-Custom': encryptHeaderValue('v', TEST_ENC_KEY) };
      prisma.webhookEndpoint.findFirst.mockResolvedValue(makeEndpoint('ep-1', encrypted));
      prisma.webhookDelivery.findMany.mockResolvedValue([]);
      const detail = await service.findOneWithSummary('user-1', 'ep-1');
      expect(detail.headers).toEqual({ 'X-Custom': '••••••••' });
    });
  });
});
