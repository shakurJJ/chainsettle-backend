// Stub collaborators so the suite doesn't compile their (unrelated) module graphs.
jest.mock('./arbiters.service', () => ({ ArbitersService: class {} }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ArbiterDirectoryService, reputationScore } from './arbiter-directory.service';

const rep = (address: string, handled: number, open: number) => ({
  arbiterAddress: address,
  disputesHandled: handled,
  disputesOpen: open,
  averageResolutionTimeHours: handled ? 12 : null,
  hasHistory: handled + open > 0,
  computedAt: new Date().toISOString(),
});

describe('ArbiterDirectoryService', () => {
  let prisma: any;
  let arbiters: any;
  let service: ArbiterDirectoryService;

  const users = [
    {
      stellarAddress: 'GA',
      name: 'Alice',
      organization: 'Acme Arbitration',
      arbiterAvailable: true,
    },
    {
      stellarAddress: 'GB',
      name: 'Bob',
      organization: null,
      arbiterAvailable: false,
    },
    {
      stellarAddress: 'GC',
      name: 'Carol',
      organization: 'Neutral Co',
      arbiterAvailable: true,
    },
  ];
  const reps: Record<string, ReturnType<typeof rep>> = {
    GA: rep('GA', 9, 1), // 90
    GB: rep('GB', 1, 1), // 50
    GC: rep('GC', 0, 0), // no history
  };

  beforeEach(() => {
    prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue(users),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    arbiters = {
      getReputation: jest.fn((a: string) => Promise.resolve(reps[a])),
    };
    service = new ArbiterDirectoryService(prisma, arbiters);
  });

  it('only queries opted-in, active ARBITER users and selects no private fields', async () => {
    await service.list({});
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      role: UserRole.ARBITER,
      listedInDirectory: true,
      deactivatedAt: null,
    });
    expect(Object.keys(args.select).sort()).toEqual(['arbiterAvailable', 'name', 'organization', 'stellarAddress']);
  });

  it('never returns email or KYC data', async () => {
    const { data } = await service.list({});
    for (const entry of data) {
      expect(entry).not.toHaveProperty('email');
      expect(entry).not.toHaveProperty('kycReference');
      expect(entry).not.toHaveProperty('kycStatus');
    }
  });

  it('returns score, resolved count and availability, ordered by score', async () => {
    const { data, total } = await service.list({});
    expect(total).toBe(3);
    expect(data.map((d) => d.address)).toEqual(['GA', 'GB', 'GC']);
    expect(data[0]).toMatchObject({
      resolvedDisputes: 9,
      available: true,
      reputation: { score: 90 },
    });
    expect(data[2].reputation.score).toBeNull();
  });

  it('pushes available and q filters into the query', async () => {
    await service.list({ available: true, q: '  acme ' });
    const { where } = prisma.user.findMany.mock.calls[0][0];
    expect(where.arbiterAvailable).toBe(true);
    expect(where.OR).toEqual([
      { name: { contains: 'acme', mode: 'insensitive' } },
      { organization: { contains: 'acme', mode: 'insensitive' } },
    ]);
  });

  it('ignores a blank q', async () => {
    await service.list({ q: '   ' });
    expect(prisma.user.findMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it('minScore excludes lower scores and arbiters without history (inclusive boundary)', async () => {
    const res = await service.list({ minScore: 50 });
    expect(res.data.map((d) => d.address)).toEqual(['GA', 'GB']);
    expect((await service.list({ minScore: 91 })).total).toBe(0);
  });

  it('combines filters with pagination', async () => {
    const res = await service.list({ minScore: 0, page: 2, limit: 1 });
    expect(res).toMatchObject({ total: 2, page: 2, limit: 1, totalPages: 2 });
    expect(res.data.map((d) => d.address)).toEqual(['GB']);
  });

  it('returns an empty page past the end', async () => {
    const res = await service.list({ page: 5, limit: 20 });
    expect(res.data).toEqual([]);
    expect(res.total).toBe(3);
  });

  describe('updateOwnProfile', () => {
    it('lets an arbiter opt out and set availability', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ARBITER });
      prisma.user.update.mockResolvedValue({
        listedInDirectory: false,
        arbiterAvailable: false,
        organization: 'X',
      });
      const res = await service.updateOwnProfile('u1', {
        listedInDirectory: false,
        available: false,
        organization: ' X ',
      });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            listedInDirectory: false,
            arbiterAvailable: false,
            organization: 'X',
          },
        }),
      );
      expect(res).toEqual({
        listedInDirectory: false,
        available: false,
        organization: 'X',
      });
    });

    it('clears organization when given an empty string', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.ARBITER });
      prisma.user.update.mockResolvedValue({
        listedInDirectory: true,
        arbiterAvailable: true,
        organization: null,
      });
      await service.updateOwnProfile('u1', { organization: '  ' });
      expect(prisma.user.update.mock.calls[0][0].data.organization).toBeNull();
    });

    it('rejects non-arbiters and unknown users', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ role: UserRole.BUYER });
      await expect(service.updateOwnProfile('u1', {})).rejects.toBeInstanceOf(ForbiddenException);
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.updateOwnProfile('u1', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('reputationScore', () => {
  it('is null without history and a rounded percentage otherwise', () => {
    expect(reputationScore({ disputesHandled: 0, disputesOpen: 0 })).toBeNull();
    expect(reputationScore({ disputesHandled: 0, disputesOpen: 3 })).toBe(0);
    expect(reputationScore({ disputesHandled: 2, disputesOpen: 1 })).toBe(67);
    expect(reputationScore({ disputesHandled: 5, disputesOpen: 0 })).toBe(100);
  });
});
