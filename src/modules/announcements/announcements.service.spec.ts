import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AnnouncementSeverity, UserRole } from '@prisma/client';
import { AnnouncementsService } from './announcements.service';

describe('AnnouncementsService', () => {
  let prisma: any;
  let service: AnnouncementsService;
  const now = new Date('2026-09-29T12:00:00Z');

  beforeEach(() => {
    prisma = {
      announcement: {
        create: jest.fn((args) => Promise.resolve({ id: 'a1', ...args.data })),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn((args) => Promise.resolve({ id: args.where.id, ...args.data })),
        delete: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      announcementDismissal: { upsert: jest.fn() },
    };
    service = new AnnouncementsService(prisma);
  });

  describe('create', () => {
    it('defaults startsAt to now, trims text and dedupes roles', async () => {
      const before = Date.now();
      await service.create(
        {
          title: ' Maintenance ',
          body: ' Down at 2am ',
          audienceRoles: [UserRole.BUYER, UserRole.BUYER],
        },
        'admin-1',
      );
      const data = prisma.announcement.create.mock.calls[0][0].data;
      expect(data.title).toBe('Maintenance');
      expect(data.body).toBe('Down at 2am');
      expect(data.audienceRoles).toEqual([UserRole.BUYER]);
      expect(data.endsAt).toBeNull();
      expect(data.createdById).toBe('admin-1');
      expect(data.startsAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('rejects endsAt at or before startsAt', async () => {
      const startsAt = new Date('2026-10-01T00:00:00Z');
      await expect(service.create({ title: 't', body: 'b', startsAt, endsAt: startsAt })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.create({
          title: 't',
          body: 'b',
          startsAt,
          endsAt: new Date('2026-09-30T00:00:00Z'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('validates the merged schedule against the stored values', async () => {
      prisma.announcement.findUnique.mockResolvedValue({
        id: 'a1',
        startsAt: new Date('2026-10-01T00:00:00Z'),
        endsAt: new Date('2026-10-02T00:00:00Z'),
      });
      await expect(service.update('a1', { startsAt: new Date('2026-10-03T00:00:00Z') })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.update('a1', { title: 'New' })).resolves.toMatchObject({ title: 'New' });
    });

    it('404s for unknown ids', async () => {
      prisma.announcement.findUnique.mockResolvedValue(null);
      await expect(service.update('x', {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove('x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findActiveForUser', () => {
    it('filters by schedule window, role and dismissals', async () => {
      await service.findActiveForUser('u1', UserRole.SUPPLIER, now);
      const { where } = prisma.announcement.findMany.mock.calls[0][0];
      expect(where.startsAt).toEqual({ lte: now });
      expect(where.AND).toEqual([
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        {
          OR: [{ audienceRoles: { isEmpty: true } }, { audienceRoles: { has: UserRole.SUPPLIER } }],
        },
      ]);
      expect(where.dismissals).toEqual({ none: { userId: 'u1' } });
    });

    it('orders CRITICAL before WARNING before INFO', async () => {
      prisma.announcement.findMany.mockResolvedValue([
        { id: 'i', severity: AnnouncementSeverity.INFO },
        { id: 'c', severity: AnnouncementSeverity.CRITICAL },
        { id: 'w', severity: AnnouncementSeverity.WARNING },
      ]);
      const res = await service.findActiveForUser('u1', UserRole.BUYER, now);
      expect(res.map((a) => a.id)).toEqual(['c', 'w', 'i']);
    });
  });

  describe('dismiss', () => {
    it('upserts so repeated dismissals are idempotent', async () => {
      prisma.announcement.findUnique.mockResolvedValue({ id: 'a1' });
      await service.dismiss('a1', 'u1');
      await service.dismiss('a1', 'u1');
      expect(prisma.announcementDismissal.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.announcementDismissal.upsert).toHaveBeenCalledWith({
        where: {
          announcementId_userId: { announcementId: 'a1', userId: 'u1' },
        },
        create: { announcementId: 'a1', userId: 'u1' },
        update: {},
      });
    });

    it('404s for unknown announcements', async () => {
      prisma.announcement.findUnique.mockResolvedValue(null);
      await expect(service.dismiss('nope', 'u1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.announcementDismissal.upsert).not.toHaveBeenCalled();
    });
  });

  it('paginates the admin list', async () => {
    prisma.announcement.count.mockResolvedValue(45);
    const res = await service.findAll(2, 20);
    expect(prisma.announcement.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
    expect(res.totalPages).toBe(3);
  });
});
