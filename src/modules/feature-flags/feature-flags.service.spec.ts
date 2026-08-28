import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagsService, FEATURE_FLAG_PREFIX } from './feature-flags.service';
import { RedisService } from '../../common/redis/redis.service';

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;
  let redis: {
    getJson: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    getClient: jest.Mock;
  };
  let scan: jest.Mock;

  beforeEach(async () => {
    scan = jest.fn();
    redis = {
      getJson: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      getClient: jest.fn().mockReturnValue({ scan }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagsService,
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<FeatureFlagsService>(FeatureFlagsService);
  });

  // -- Key layout -------------------------------------------------------------

  describe('key layout', () => {
    it('namespaces flags under the feature-flag prefix', async () => {
      redis.getJson.mockResolvedValue({ enabled: true });

      await service.isEnabled('ipfs-proofs');

      expect(redis.getJson).toHaveBeenCalledWith(
        FEATURE_FLAG_PREFIX + 'ipfs-proofs',
      );
    });
  });

  // -- Boolean flags ----------------------------------------------------------

  describe('boolean flags', () => {
    it('is off when the flag has never been set', async () => {
      redis.getJson.mockResolvedValue(null);

      await expect(service.isEnabled('unknown-flag')).resolves.toBe(false);
    });

    it('is on when enabled is true', async () => {
      redis.getJson.mockResolvedValue({ enabled: true });

      await expect(service.isEnabled('templates')).resolves.toBe(true);
    });

    it('is off when enabled is false', async () => {
      redis.getJson.mockResolvedValue({ enabled: false });

      await expect(service.isEnabled('templates')).resolves.toBe(false);
    });

    it('treats a malformed stored value as unset', async () => {
      redis.getJson.mockResolvedValue({ nonsense: true });

      await expect(service.isEnabled('templates')).resolves.toBe(false);
      await expect(service.getFlag('templates')).resolves.toBeNull();
    });

    it('lets enabled=false kill a fully rolled out flag', async () => {
      redis.getJson.mockResolvedValue({ enabled: false, rollout: 100 });

      await expect(service.isEnabled('templates', 'user-1')).resolves.toBe(false);
    });
  });

  // -- Percentage rollout -----------------------------------------------------

  describe('percentage rollout', () => {
    it('is on for everyone at 100 percent', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 100 });

      await expect(service.isEnabled('webhooks', 'user-1')).resolves.toBe(true);
      await expect(service.isEnabled('webhooks', 'user-2')).resolves.toBe(true);
    });

    it('is off for everyone at 0 percent', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 0 });

      await expect(service.isEnabled('webhooks', 'user-1')).resolves.toBe(false);
      await expect(service.isEnabled('webhooks', 'user-2')).resolves.toBe(false);
    });

    it('gives the same answer every time for the same subject', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 50 });

      const first = await service.isEnabled('webhooks', 'user-1');
      const second = await service.isEnabled('webhooks', 'user-1');
      const third = await service.isEnabled('webhooks', 'user-1');

      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it('splits a population roughly in line with the percentage', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 30 });

      const subjects = Array.from({ length: 1000 }, (_, i) => 'user-' + i);
      const results = await Promise.all(
        subjects.map((s) => service.isEnabled('webhooks', s)),
      );
      const onCount = results.filter(Boolean).length;

      // Hash bucketing is not perfectly uniform on a finite sample, so assert
      // the split lands in the right neighbourhood rather than exactly 300.
      expect(onCount).toBeGreaterThan(240);
      expect(onCount).toBeLessThan(360);
    });

    it('buckets a subject independently per flag', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 50 });

      const subjects = Array.from({ length: 200 }, (_, i) => 'user-' + i);
      const forFlagA = await Promise.all(
        subjects.map((s) => service.isEnabled('flag-a', s)),
      );
      const forFlagB = await Promise.all(
        subjects.map((s) => service.isEnabled('flag-b', s)),
      );

      // Were the flag name not part of the hash these would be identical.
      expect(forFlagA).not.toEqual(forFlagB);
    });

    it('is off for an anonymous caller rather than flapping between requests', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 50 });

      await expect(service.isEnabled('webhooks')).resolves.toBe(false);
    });

    it('clamps an out-of-range stored rollout', async () => {
      redis.getJson.mockResolvedValue({ enabled: true, rollout: 250 });
      await expect(service.getFlag('webhooks')).resolves.toEqual({
        enabled: true,
        rollout: 100,
      });

      redis.getJson.mockResolvedValue({ enabled: true, rollout: -40 });
      await expect(service.getFlag('webhooks')).resolves.toEqual({
        enabled: true,
        rollout: 0,
      });
    });
  });

  // -- Live toggling ----------------------------------------------------------

  describe('live toggling', () => {
    it('reads Redis on every check so a toggle needs no restart', async () => {
      redis.getJson.mockResolvedValueOnce({ enabled: false });
      await expect(service.isEnabled('templates')).resolves.toBe(false);

      // Somebody flips the flag in Redis. No restart, no cache to invalidate.
      redis.getJson.mockResolvedValueOnce({ enabled: true });
      await expect(service.isEnabled('templates')).resolves.toBe(true);

      expect(redis.getJson).toHaveBeenCalledTimes(2);
    });
  });

  // -- Writes -----------------------------------------------------------------

  describe('setFlag', () => {
    it('stores a boolean flag with no TTL', async () => {
      await service.setFlag('templates', { enabled: true });

      expect(redis.set).toHaveBeenCalledWith(
        FEATURE_FLAG_PREFIX + 'templates',
        JSON.stringify({ enabled: true }),
      );
    });

    it('stores a rollout percentage when given', async () => {
      await service.setFlag('templates', { enabled: true, rollout: 25 });

      expect(redis.set).toHaveBeenCalledWith(
        FEATURE_FLAG_PREFIX + 'templates',
        JSON.stringify({ enabled: true, rollout: 25 }),
      );
    });

    it('clamps a rollout above 100 before storing', async () => {
      await service.setFlag('templates', { enabled: true, rollout: 140 });

      expect(redis.set).toHaveBeenCalledWith(
        FEATURE_FLAG_PREFIX + 'templates',
        JSON.stringify({ enabled: true, rollout: 100 }),
      );
    });
  });

  describe('deleteFlag', () => {
    it('removes the key so the flag reads as unset', async () => {
      await service.deleteFlag('templates');

      expect(redis.del).toHaveBeenCalledWith(FEATURE_FLAG_PREFIX + 'templates');
    });
  });

  // -- Listing ----------------------------------------------------------------

  describe('listFlags', () => {
    it('scans the keyspace and returns each flag with its name', async () => {
      scan.mockResolvedValueOnce([
        '0',
        [FEATURE_FLAG_PREFIX + 'templates', FEATURE_FLAG_PREFIX + 'webhooks'],
      ]);
      redis.getJson
        .mockResolvedValueOnce({ enabled: true })
        .mockResolvedValueOnce({ enabled: true, rollout: 10 });

      const flags = await service.listFlags();

      expect(flags).toEqual([
        { name: 'templates', enabled: true },
        { name: 'webhooks', enabled: true, rollout: 10 },
      ]);
    });

    it('follows the cursor until the scan completes', async () => {
      scan
        .mockResolvedValueOnce(['42', [FEATURE_FLAG_PREFIX + 'a']])
        .mockResolvedValueOnce(['0', [FEATURE_FLAG_PREFIX + 'b']]);
      redis.getJson.mockResolvedValue({ enabled: true });

      const flags = await service.listFlags();

      expect(scan).toHaveBeenCalledTimes(2);
      expect(flags.map((f) => f.name)).toEqual(['a', 'b']);
    });

    it('returns an empty list when nothing is configured', async () => {
      scan.mockResolvedValueOnce(['0', []]);

      await expect(service.listFlags()).resolves.toEqual([]);
    });
  });
});
