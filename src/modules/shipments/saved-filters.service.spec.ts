import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SavedFiltersService } from './saved-filters.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('SavedFiltersService', () => {
  let service: SavedFiltersService;
  let prisma: {
    savedFilter: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };

  const USER = 'user-1';
  const OTHER_USER = 'user-2';

  beforeEach(async () => {
    prisma = {
      savedFilter: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedFiltersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<SavedFiltersService>(SavedFiltersService);
  });

  // -- Create -----------------------------------------------------------------

  describe('create', () => {
    it('saves a named filter combination for the user', async () => {
      prisma.savedFilter.create.mockResolvedValue({ id: 'f1' });

      await service.create(USER, 'Overdue as supplier', {
        status: 'DISPUTED',
        tags: 'urgent',
      });

      expect(prisma.savedFilter.create).toHaveBeenCalledWith({
        data: {
          userId: USER,
          name: 'Overdue as supplier',
          filter: { status: 'DISPUTED', tags: 'urgent' },
        },
      });
    });

    it('rejects a duplicate name for the same user', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create(USER, 'Overdue', { status: 'ACTIVE' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.savedFilter.create).not.toHaveBeenCalled();
    });

    it('scopes the duplicate-name check to the calling user', async () => {
      prisma.savedFilter.create.mockResolvedValue({ id: 'f1' });

      await service.create(USER, 'Overdue', { status: 'ACTIVE' });

      expect(prisma.savedFilter.findFirst).toHaveBeenCalledWith({
        where: { userId: USER, name: 'Overdue' },
      });
    });

    it('rejects an unrecognised filter field', async () => {
      await expect(
        service.create(USER, 'Bad', { statuss: 'ACTIVE' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.savedFilter.create).not.toHaveBeenCalled();
    });

    it('names the offending field so a typo is obvious', async () => {
      await expect(
        service.create(USER, 'Bad', { statuss: 'ACTIVE' }),
      ).rejects.toThrow(/statuss/);
    });

    it('refuses to store pagination, which is per-request', async () => {
      await expect(
        service.create(USER, 'Paged', { status: 'ACTIVE', page: '2' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an empty filter', async () => {
      await expect(service.create(USER, 'Empty', {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('drops null and undefined values rather than storing them', async () => {
      prisma.savedFilter.create.mockResolvedValue({ id: 'f1' });

      await service.create(USER, 'Partial', {
        status: 'ACTIVE',
        search: null,
        tags: undefined,
      });

      expect(prisma.savedFilter.create).toHaveBeenCalledWith({
        data: { userId: USER, name: 'Partial', filter: { status: 'ACTIVE' } },
      });
    });
  });

  // -- Read -------------------------------------------------------------------

  describe('findAll', () => {
    it('returns only the calling user filters', async () => {
      await service.findAll(USER);

      expect(prisma.savedFilter.findMany).toHaveBeenCalledWith({
        where: { userId: USER },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findOne', () => {
    it('returns a filter belonging to the caller', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({ id: 'f1', userId: USER });

      await expect(service.findOne(USER, 'f1')).resolves.toEqual({
        id: 'f1',
        userId: USER,
      });
    });

    it('scopes the lookup by user id', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({ id: 'f1' });

      await service.findOne(USER, 'f1');

      expect(prisma.savedFilter.findFirst).toHaveBeenCalledWith({
        where: { id: 'f1', userId: USER },
      });
    });

    it('404s for a filter owned by somebody else', async () => {
      // Scoped query returns nothing for a filter belonging to OTHER_USER.
      prisma.savedFilter.findFirst.mockResolvedValue(null);

      await expect(service.findOne(OTHER_USER, 'f1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -- Update -----------------------------------------------------------------

  describe('update', () => {
    it('renames a filter', async () => {
      prisma.savedFilter.findFirst
        .mockResolvedValueOnce({ id: 'f1', userId: USER })
        .mockResolvedValueOnce(null);
      prisma.savedFilter.update.mockResolvedValue({ id: 'f1', name: 'New' });

      await service.update(USER, 'f1', { name: 'New' });

      expect(prisma.savedFilter.update).toHaveBeenCalledWith({
        where: { id: 'f1' },
        data: { name: 'New' },
      });
    });

    it('replaces the criteria', async () => {
      prisma.savedFilter.findFirst.mockResolvedValueOnce({ id: 'f1', userId: USER });
      prisma.savedFilter.update.mockResolvedValue({ id: 'f1' });

      await service.update(USER, 'f1', { filter: { status: 'COMPLETED' } });

      expect(prisma.savedFilter.update).toHaveBeenCalledWith({
        where: { id: 'f1' },
        data: { filter: { status: 'COMPLETED' } },
      });
    });

    it('validates replacement criteria the same way as creation', async () => {
      prisma.savedFilter.findFirst.mockResolvedValueOnce({ id: 'f1', userId: USER });

      await expect(
        service.update(USER, 'f1', { filter: { bogus: 1 } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a rename that collides with another of the same user filters', async () => {
      prisma.savedFilter.findFirst
        .mockResolvedValueOnce({ id: 'f1', userId: USER })
        .mockResolvedValueOnce({ id: 'f2', userId: USER });

      await expect(service.update(USER, 'f1', { name: 'Taken' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('404s when the filter is not the caller own', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue(null);

      await expect(service.update(OTHER_USER, 'f1', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.savedFilter.update).not.toHaveBeenCalled();
    });
  });

  // -- Delete -----------------------------------------------------------------

  describe('remove', () => {
    it('deletes a filter belonging to the caller', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({ id: 'f1', userId: USER });

      await expect(service.remove(USER, 'f1')).resolves.toEqual({
        deleted: true,
        id: 'f1',
      });
      expect(prisma.savedFilter.delete).toHaveBeenCalledWith({
        where: { id: 'f1' },
      });
    });

    it('404s rather than deleting somebody else filter', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue(null);

      await expect(service.remove(OTHER_USER, 'f1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.savedFilter.delete).not.toHaveBeenCalled();
    });
  });

  // -- Applying a preset ------------------------------------------------------

  describe('applyTo', () => {
    it('supplies the stored criteria when the request adds nothing', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({
        id: 'f1',
        userId: USER,
        filter: { status: 'DISPUTED', tags: 'urgent' },
      });

      const merged = await service.applyTo(USER, 'f1', {
        savedFilterId: 'f1',
      } as Record<string, unknown>);

      expect(merged).toMatchObject({ status: 'DISPUTED', tags: 'urgent' });
    });

    it('lets an explicit query param override the stored value', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({
        id: 'f1',
        userId: USER,
        filter: { status: 'DISPUTED', tags: 'urgent' },
      });

      const merged = (await service.applyTo(USER, 'f1', {
        savedFilterId: 'f1',
        status: 'ACTIVE',
      } as Record<string, unknown>)) as Record<string, unknown>;

      // The saved view is a starting point, narrowed by the request.
      expect(merged.status).toBe('ACTIVE');
      expect(merged.tags).toBe('urgent');
    });

    it('does not let undefined DTO keys mask the stored criteria', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({
        id: 'f1',
        userId: USER,
        filter: { status: 'DISPUTED' },
      });

      const merged = (await service.applyTo(USER, 'f1', {
        savedFilterId: 'f1',
        status: undefined,
        search: undefined,
      } as Record<string, unknown>)) as Record<string, unknown>;

      expect(merged.status).toBe('DISPUTED');
    });

    it('404s for a preset belonging to another user', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue(null);

      await expect(
        service.applyTo(OTHER_USER, 'f1', {} as Record<string, unknown>),
      ).rejects.toThrow(NotFoundException);
    });

    it('tolerates a preset with no stored criteria', async () => {
      prisma.savedFilter.findFirst.mockResolvedValue({
        id: 'f1',
        userId: USER,
        filter: null,
      });

      await expect(
        service.applyTo(USER, 'f1', { status: 'ACTIVE' } as Record<string, unknown>),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
    });
  });
});
