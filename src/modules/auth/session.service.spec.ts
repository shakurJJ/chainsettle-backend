import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { RedisService } from '../../common/redis/redis.service';

describe('SessionService', () => {
  let service: SessionService;
  let mockRedis: jest.Mocked<
    Pick<RedisService, 'sadd' | 'smembers' | 'srem' | 'set' | 'exists'>
  >;
  let mockConfig: jest.Mocked<Pick<ConfigService, 'get'>>;

  beforeEach(() => {
    mockRedis = {
      sadd: jest.fn().mockResolvedValue(undefined),
      smembers: jest.fn().mockResolvedValue([]),
      srem: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
    };

    mockConfig = {
      get: jest.fn().mockReturnValue('7d'),
    };

    service = new SessionService(
      mockRedis as unknown as RedisService,
      mockConfig as unknown as ConfigService,
    );
  });

  // ------------------------------------------------------------------
  // registerSession
  // ------------------------------------------------------------------

  describe('registerSession', () => {
    it('adds the jti to the user session set in Redis', async () => {
      await service.registerSession('user-1', 'jti-abc');

      expect(mockRedis.sadd).toHaveBeenCalledWith(
        'chainsettle:sessions:user-1',
        'jti-abc',
      );
    });
  });

  // ------------------------------------------------------------------
  // revokeAllSessions — exclude current
  // ------------------------------------------------------------------

  describe('revokeAllSessions (includeCurrent = false)', () => {
    it('blocklists all sessions except the current one', async () => {
      mockRedis.smembers.mockResolvedValue(['jti-1', 'jti-2', 'jti-current']);

      const count = await service.revokeAllSessions('user-1', 'jti-current', false);

      expect(count).toBe(2);

      // Blocklist jti-1 and jti-2, NOT jti-current
      expect(mockRedis.set).toHaveBeenCalledWith(
        'chainsettle:blocklist:jti-1',
        '1',
        expect.any(Number),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        'chainsettle:blocklist:jti-2',
        '1',
        expect.any(Number),
      );
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        'chainsettle:blocklist:jti-current',
        expect.anything(),
        expect.anything(),
      );

      // Remove the revoked jtis from the session set
      expect(mockRedis.srem).toHaveBeenCalledWith(
        'chainsettle:sessions:user-1',
        'jti-1',
        'jti-2',
      );
    });

    it('returns 0 when the user only has the current session', async () => {
      mockRedis.smembers.mockResolvedValue(['jti-current']);

      const count = await service.revokeAllSessions('user-1', 'jti-current', false);

      expect(count).toBe(0);
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockRedis.srem).not.toHaveBeenCalled();
    });

    it('returns 0 when user has no sessions at all', async () => {
      mockRedis.smembers.mockResolvedValue([]);

      const count = await service.revokeAllSessions('user-1', 'jti-current', false);

      expect(count).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // revokeAllSessions — include current
  // ------------------------------------------------------------------

  describe('revokeAllSessions (includeCurrent = true)', () => {
    it('blocklists every session including the current one', async () => {
      mockRedis.smembers.mockResolvedValue(['jti-1', 'jti-current']);

      const count = await service.revokeAllSessions('user-1', 'jti-current', true);

      expect(count).toBe(2);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'chainsettle:blocklist:jti-1',
        '1',
        expect.any(Number),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        'chainsettle:blocklist:jti-current',
        '1',
        expect.any(Number),
      );

      expect(mockRedis.srem).toHaveBeenCalledWith(
        'chainsettle:sessions:user-1',
        'jti-1',
        'jti-current',
      );
    });
  });

  // ------------------------------------------------------------------
  // isRevoked
  // ------------------------------------------------------------------

  describe('isRevoked', () => {
    it('returns true when jti is on the blocklist', async () => {
      mockRedis.exists.mockResolvedValue(true);

      const result = await service.isRevoked('jti-revoked');

      expect(result).toBe(true);
      expect(mockRedis.exists).toHaveBeenCalledWith(
        'chainsettle:blocklist:jti-revoked',
      );
    });

    it('returns false when jti is not on the blocklist', async () => {
      mockRedis.exists.mockResolvedValue(false);

      const result = await service.isRevoked('jti-valid');

      expect(result).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // parseExpiry (via constructor — tested indirectly through TTL value)
  // ------------------------------------------------------------------

  describe('expiry parsing', () => {
    const cases: Array<[string, number]> = [
      ['7d', 7 * 86400],
      ['24h', 24 * 3600],
      ['30m', 30 * 60],
      ['3600s', 3600],
      ['3600', 3600],
    ];

    it.each(cases)('parses "%s" correctly', (expiresIn, expectedTtl) => {
      mockConfig.get.mockReturnValue(expiresIn);
      const svc = new SessionService(
        mockRedis as unknown as RedisService,
        mockConfig as unknown as ConfigService,
      );
      // Trigger a revoke to observe the TTL passed to redis.set
      mockRedis.smembers.mockResolvedValue(['jti-x']);
      return svc.revokeAllSessions('u', 'other', true).then(() => {
        expect(mockRedis.set).toHaveBeenCalledWith(
          'chainsettle:blocklist:jti-x',
          '1',
          expectedTtl,
        );
      });
    });
  });
});
