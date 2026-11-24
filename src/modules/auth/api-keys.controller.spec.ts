/**
 * Unit tests for ApiKeysController.
 *
 * Covers (issue #368 — scopes):
 *   - POST /auth/api-keys   creates key with requested scopes (or defaults)
 *   - GET  /auth/api-keys   returns scopes in list response
 *   - DELETE /auth/api-keys/:id  revokes a key
 *
 * Covers (issue #367 — rotation):
 *   - POST /auth/api-keys/:id/rotate  success (immediate + grace period)
 *   - Rotating a revoked key → 409
 *   - Rotating a key owned by another user → 404
 *   - Rotating a non-existent key → 404
 *   - Audit log is written on rotation
 *
 * JWT auth is tested to confirm it is unaffected by scope/rotation logic.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { RedisService } from '../../common/redis/redis.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const currentUser = { id: USER_ID, stellarAddress: 'GABC' };

function makeDbKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    name: 'Test Key',
    scopes: ['read', 'write'],
    keyHash: 'hash',
    userId: USER_ID,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    rotatedFromId: null,
    gracePeriodEndsAt: null,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    ...overrides,
  };
}

/** Minimal fake Express Request */
function makeReq(ip = '127.0.0.1') {
  return {
    headers: {},
    socket: { remoteAddress: ip },
  } as any;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = {
  apiKey: {
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAuditLog = {
  record: jest.fn().mockResolvedValue(undefined),
};

const mockRedisClient = {
  mget: jest.fn().mockResolvedValue(new Array(30).fill(null)),
};

const mockRedis = {
  getClient: jest.fn().mockReturnValue(mockRedisClient),
};

// ---------------------------------------------------------------------------
// Module setup
// ---------------------------------------------------------------------------

describe('ApiKeysController', () => {
  let controller: ApiKeysController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: RedisService, useValue: mockRedis },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ApiKeysController>(ApiKeysController);
  });

  // ── GET /auth/api-keys ───────────────────────────────────────────────────

  describe('list()', () => {
    it('returns scopes in every key record', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([
        makeDbKey({ scopes: ['read', 'write'] }),
        makeDbKey({ id: 'key-2', name: 'Read Only', scopes: ['read'] }),
      ]);

      const result = await controller.list(currentUser);

      expect(result).toHaveLength(2);
      expect(result[0].scopes).toEqual(['read', 'write']);
      expect(result[1].scopes).toEqual(['read']);
    });

    it('queries only non-revoked keys for the caller', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([]);

      await controller.list(currentUser);

      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, revokedAt: null },
        }),
      );
    });
  });

  // ── POST /auth/api-keys ──────────────────────────────────────────────────

  describe('create()', () => {
    it('creates a read-only key when scopes: ["read"] is provided', async () => {
      const dbRecord = makeDbKey({ scopes: ['read'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create(currentUser, {
        name: 'Reporting',
        scopes: ['read'],
      });

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scopes: ['read'] }),
        }),
      );
      expect(result.scopes).toEqual(['read']);
      expect(typeof result.key).toBe('string');
      expect(result.key).toHaveLength(40);
    });

    it('defaults to ["read", "write"] when scopes is omitted', async () => {
      const dbRecord = makeDbKey({ scopes: ['read', 'write'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create(currentUser, { name: 'Full Access' });

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scopes: ['read', 'write'] }),
        }),
      );
      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('returns the plaintext key only on creation (not in list)', async () => {
      const dbRecord = makeDbKey({ scopes: ['read'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);
      mockPrisma.apiKey.findMany.mockResolvedValue([dbRecord]);

      const created = await controller.create(currentUser, { name: 'R', scopes: ['read'] });
      const listed = await controller.list(currentUser);

      expect(created.key).toBeDefined();
      expect((listed[0] as Record<string, unknown>).key).toBeUndefined();
    });
  });

  // ── POST /auth/api-keys/:id/rotate ───────────────────────────────────────

  describe('rotate()', () => {
    function setupRotateTransaction(newKeyOverrides: Record<string, unknown> = {}) {
      const oldKey = makeDbKey();
      const newKey = makeDbKey({
        id: 'key-new',
        rotatedFromId: 'key-1',
        ...newKeyOverrides,
      });

      mockPrisma.apiKey.findUnique.mockResolvedValue(oldKey);
      // $transaction receives an array of promises; mock resolves [updated, created]
      mockPrisma.$transaction.mockImplementation(
        async (ops: Array<Promise<unknown>>) => Promise.all(ops),
      );
      mockPrisma.apiKey.update.mockResolvedValue({ ...oldKey, revokedAt: new Date() });
      mockPrisma.apiKey.create.mockResolvedValue(newKey);

      return { oldKey, newKey };
    }

    it('returns a new plaintext key on success', async () => {
      setupRotateTransaction();

      const result = await controller.rotate(currentUser, 'key-1', {}, makeReq());

      expect(typeof result.key).toBe('string');
      expect(result.key).toHaveLength(40);
    });

    it('new key inherits name and scopes from the predecessor', async () => {
      setupRotateTransaction();

      const result = await controller.rotate(currentUser, 'key-1', {}, makeReq());

      expect(result.name).toBe('Test Key');
      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('sets rotatedFromId to the old key id', async () => {
      setupRotateTransaction();

      const result = await controller.rotate(currentUser, 'key-1', {}, makeReq());

      expect(result.rotatedFromId).toBe('key-1');
    });

    it('revokes old key immediately when no gracePeriodSeconds', async () => {
      setupRotateTransaction();

      await controller.rotate(currentUser, 'key-1', {}, makeReq());

      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          data: expect.objectContaining({
            revokedAt: expect.any(Date),
            gracePeriodEndsAt: null,
          }),
        }),
      );
    });

    it('sets gracePeriodEndsAt on old key when gracePeriodSeconds is provided', async () => {
      setupRotateTransaction();

      const before = Date.now();
      await controller.rotate(
        currentUser,
        'key-1',
        { gracePeriodSeconds: 300 },
        makeReq(),
      );
      const after = Date.now();

      const updateCall = mockPrisma.apiKey.update.mock.calls[0][0];
      const grace: Date = updateCall.data.gracePeriodEndsAt;

      expect(grace).toBeInstanceOf(Date);
      // gracePeriodEndsAt should be ~300 s from now
      expect(grace.getTime()).toBeGreaterThanOrEqual(before + 299_000);
      expect(grace.getTime()).toBeLessThanOrEqual(after + 301_000);
    });

    it('includes gracePeriodEndsAt in the response when a grace period is set', async () => {
      setupRotateTransaction();

      const result = await controller.rotate(
        currentUser,
        'key-1',
        { gracePeriodSeconds: 600 },
        makeReq(),
      );

      expect(result.gracePeriodEndsAt).toBeInstanceOf(Date);
    });

    it('gracePeriodEndsAt is null in response when gracePeriodSeconds is omitted', async () => {
      setupRotateTransaction();

      const result = await controller.rotate(currentUser, 'key-1', {}, makeReq());

      expect(result.gracePeriodEndsAt).toBeNull();
    });

    it('writes an audit log entry with action API_KEY_ROTATED', async () => {
      setupRotateTransaction();

      await controller.rotate(currentUser, 'key-1', {}, makeReq());

      // Give the fire-and-forget a tick to run
      await new Promise((r) => setImmediate(r));

      expect(mockAuditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'API_KEY_ROTATED',
          resourceType: 'api_key',
          metadata: expect.objectContaining({
            oldKeyId: 'key-1',
            newKeyId: 'key-new',
          }),
        }),
      );
    });

    it('throws 404 when key does not exist', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(
        controller.rotate(currentUser, 'nonexistent', {}, makeReq()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 (not 403) when key belongs to a different user — prevents enumeration', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(
        makeDbKey({ userId: 'other-user' }),
      );

      await expect(
        controller.rotate(currentUser, 'key-1', {}, makeReq()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 409 API_KEY_ALREADY_REVOKED when rotating a revoked key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(
        makeDbKey({ revokedAt: new Date() }),
      );

      const err = await controller
        .rotate(currentUser, 'key-1', {}, makeReq())
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('API_KEY_ALREADY_REVOKED');
    });

    it('does NOT call $transaction when pre-validation fails', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(
        controller.rotate(currentUser, 'nonexistent', {}, makeReq()),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /auth/api-keys/:id ────────────────────────────────────────────

  describe('revoke()', () => {
    it('revokes a key owned by the caller', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(makeDbKey());
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });

      const result = await controller.revoke(currentUser, 'key-1');

      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
      expect(result.message).toMatch(/revoked/i);
    });

    it('throws 404 when key does not exist', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(controller.revoke(currentUser, 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 404 when key is already revoked', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(
        makeDbKey({ revokedAt: new Date() }),
      );

      await expect(controller.revoke(currentUser, 'key-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 403 when key belongs to a different user', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(
        makeDbKey({ userId: 'other-user' }),
      );

      await expect(controller.revoke(currentUser, 'key-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── JWT auth unaffected ──────────────────────────────────────────────────

  describe('JWT auth compatibility', () => {
    it('list() works for a JWT-authenticated caller', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([makeDbKey()]);

      const result = await controller.list({ id: 'jwt-user-1' });

      expect(Array.isArray(result)).toBe(true);
    });

    it('create() works for a JWT-authenticated caller', async () => {
      const dbRecord = makeDbKey({ scopes: ['read', 'write'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create({ id: 'jwt-user-1' }, { name: 'Key' });

      expect(result.scopes).toEqual(['read', 'write']);
    });
  });

  // ── GET /auth/api-keys/:id/usage ─────────────────────────────────────────

  describe('getUsage()', () => {
    it('returns 30-day daily usage and lastUsedAt for the key owner', async () => {
      const lastUsed = new Date('2026-10-18T12:00:00Z');
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        name: 'Production Key',
        userId: USER_ID,
        lastUsedAt: lastUsed,
      });

      // Mock 30 daily counts: 28 days null, one day '5', today '10'
      const counts = new Array(30).fill(null);
      counts[0] = '5';
      counts[29] = '10';
      mockRedisClient.mget.mockResolvedValue(counts);

      const result = await controller.getUsage(currentUser, 'key-1');

      expect(mockPrisma.apiKey.findUnique).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        select: {
          id: true,
          userId: true,
          name: true,
          lastUsedAt: true,
        },
      });

      expect(mockRedisClient.mget).toHaveBeenCalledTimes(1);
      const mgetArgs = mockRedisClient.mget.mock.calls[0];
      expect(mgetArgs).toHaveLength(30);
      expect(mgetArgs[0]).toContain('chainsettle:api-key:usage:key-1:');

      expect(result).toMatchObject({
        id: 'key-1',
        name: 'Production Key',
        lastUsedAt: lastUsed,
        totalRequests30d: 15,
      });
      expect(result.dailyUsage).toHaveLength(30);
      expect(result.dailyUsage[0].count).toBe(5);
      expect(result.dailyUsage[29].count).toBe(10);
    });

    it('throws NotFoundException when the key does not exist', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(controller.getUsage(currentUser, 'non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when requested by a different user', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        name: 'Other Key',
        userId: 'different-user',
        lastUsedAt: null,
      });

      await expect(controller.getUsage(currentUser, 'key-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockRedisClient.mget).not.toHaveBeenCalled();
    });
  });
});
