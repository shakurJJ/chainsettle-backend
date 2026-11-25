import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RecurringInterval, TemplateVisibility } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecurringSchedulesService, advance } from './recurring-schedules.service';

describe('advance()', () => {
  it('adds 7 days for WEEKLY', () => {
    const from = new Date('2024-01-01T00:00:00.000Z');
    expect(advance(from, RecurringInterval.WEEKLY).toISOString()).toBe(
      '2024-01-08T00:00:00.000Z',
    );
  });

  it('adds one month for MONTHLY', () => {
    const from = new Date('2024-01-15T00:00:00.000Z');
    expect(advance(from, RecurringInterval.MONTHLY).toISOString()).toBe(
      '2024-02-15T00:00:00.000Z',
    );
  });

  it('clamps MONTHLY to month end (Jan 31 -> Feb 28)', () => {
    const from = new Date('2024-01-31T00:00:00.000Z');
    expect(advance(from, RecurringInterval.MONTHLY).toISOString()).toBe(
      '2024-02-29T00:00:00.000Z',
    );
  });

  it('clamps MONTHLY to month end for non-leap year (Jan 31 -> Feb 28)', () => {
    const from = new Date('2023-01-31T00:00:00.000Z');
    expect(advance(from, RecurringInterval.MONTHLY).toISOString()).toBe(
      '2023-02-28T00:00:00.000Z',
    );
  });

  it('clamps MONTHLY from Mar 31 -> Apr 30', () => {
    const from = new Date('2024-03-31T00:00:00.000Z');
    expect(advance(from, RecurringInterval.MONTHLY).toISOString()).toBe(
      '2024-04-30T00:00:00.000Z',
    );
  });
});

describe('RecurringSchedulesService', () => {
  const NOW = new Date('2024-01-15T12:00:00.000Z');

  let service: RecurringSchedulesService;
  let prisma: {
    recurringSchedule: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    shipmentTemplate: {
      findUnique: jest.Mock;
    };
  };

  const userId = 'user-1';

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    prisma = {
      recurringSchedule: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      shipmentTemplate: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringSchedulesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<RecurringSchedulesService>(RecurringSchedulesService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  const validTemplate = {
    id: 'template-1',
    ownerId: userId,
    visibility: TemplateVisibility.PRIVATE,
    originAddress: 'Origin St 1',
    destinationAddress: 'Dest St 2',
    originCity: 'City A',
    destinationCity: 'City B',
    originPostalCode: '1000',
    destinationPostalCode: '2000',
    originCountry: 'US',
    destinationCountry: 'US',
  };

  describe('create()', () => {
    it('computes nextRunAt from startAt', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue(validTemplate);
      prisma.recurringSchedule.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'schedule-1', ...data }),
      );

      const startAt = new Date('2024-02-01T00:00:00.000Z');
      const result = await service.create(userId, {
        templateId: 'template-1',
        interval: RecurringInterval.WEEKLY,
        startAt,
        totalAmount: 100,
      });

      expect(prisma.recurringSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextRunAt: new Date('2024-02-01T00:00:00.000Z'),
          }),
        }),
      );
      expect(result.nextRunAt).toEqual(new Date('2024-02-01T00:00:00.000Z'));
    });

    it('defaults nextRunAt to one interval from now when startAt is omitted', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue(validTemplate);
      prisma.recurringSchedule.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'schedule-1', ...data }),
      );

      await service.create(userId, {
        templateId: 'template-1',
        interval: RecurringInterval.WEEKLY,
        totalAmount: 100,
      });

      expect(prisma.recurringSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextRunAt: new Date('2024-01-22T12:00:00.000Z'),
          }),
        }),
      );
    });

    it('defaults nextRunAt to one month from now for MONTHLY', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue(validTemplate);
      prisma.recurringSchedule.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'schedule-1', ...data }),
      );

      await service.create(userId, {
        templateId: 'template-1',
        interval: RecurringInterval.MONTHLY,
        totalAmount: 100,
      });

      expect(prisma.recurringSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextRunAt: new Date('2024-02-15T12:00:00.000Z'),
          }),
        }),
      );
    });

    it('rejects a past startAt with BadRequestException', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue(validTemplate);

      await expect(
        service.create(userId, {
          templateId: 'template-1',
          interval: RecurringInterval.WEEKLY,
          startAt: new Date('2024-01-01T00:00:00.000Z'),
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.recurringSchedule.create).not.toHaveBeenCalled();
    });

    it('rejects a missing template with NotFoundException', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue(null);

      await expect(
        service.create(userId, {
          templateId: 'missing',
          interval: RecurringInterval.WEEKLY,
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a foreign private template with ForbiddenException', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue({
        ...validTemplate,
        ownerId: 'someone-else',
      });

      await expect(
        service.create(userId, {
          templateId: 'template-1',
          interval: RecurringInterval.WEEKLY,
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a template missing required address fields with BadRequestException', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue({
        ...validTemplate,
        originAddress: null,
      });

      await expect(
        service.create(userId, {
          templateId: 'template-1',
          interval: RecurringInterval.WEEKLY,
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('serializes totalAmount to a string', async () => {
      prisma.shipmentTemplate.findUnique.mockResolvedValue(validTemplate);
      prisma.recurringSchedule.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'schedule-1', ...data }),
      );

      await service.create(userId, {
        templateId: 'template-1',
        interval: RecurringInterval.WEEKLY,
        totalAmount: 123.45,
      });

      expect(prisma.recurringSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalAmount: '123.45',
          }),
        }),
      );
    });
  });

  describe('findMine()', () => {
    it('returns schedules for the user ordered by nextRunAt', async () => {
      const schedules = [{ id: 'a' }, { id: 'b' }];
      prisma.recurringSchedule.findMany.mockResolvedValue(schedules);

      const result = await service.findMine(userId);

      expect(prisma.recurringSchedule.findMany).toHaveBeenCalledWith({
        where: { userId },
        orderBy: { nextRunAt: 'asc' },
      });
      expect(result).toEqual(schedules);
    });
  });

  describe('update()', () => {
    it('validates nextRunAt is in the future', async () => {
      prisma.recurringSchedule.findUnique.mockResolvedValue({
        id: 'schedule-1',
        userId,
      });

      await expect(
        service.update(userId, 'schedule-1', {
          nextRunAt: new Date('2024-01-01T00:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.recurringSchedule.update).not.toHaveBeenCalled();
    });

    it('converts totalAmount to a string', async () => {
      prisma.recurringSchedule.findUnique.mockResolvedValue({
        id: 'schedule-1',
        userId,
      });
      prisma.recurringSchedule.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'schedule-1', ...data }),
      );

      await service.update(userId, 'schedule-1', { totalAmount: 50 });

      expect(prisma.recurringSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ totalAmount: '50' }),
        }),
      );
    });

    it('throws NotFoundException for non-owners', async () => {
      prisma.recurringSchedule.findUnique.mockResolvedValue({
        id: 'schedule-1',
        userId: 'someone-else',
      });

      await expect(
        service.update(userId, 'schedule-1', { totalAmount: 50 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove()', () => {
    it('delegates to findOwned and deletes the schedule', async () => {
      prisma.recurringSchedule.findUnique.mockResolvedValue({
        id: 'schedule-1',
        userId,
      });
      prisma.recurringSchedule.delete.mockResolvedValue({ id: 'schedule-1' });

      await service.remove(userId, 'schedule-1');

      expect(prisma.recurringSchedule.delete).toHaveBeenCalledWith({
        where: { id: 'schedule-1' },
      });
    });

    it('throws NotFoundException for non-owners', async () => {
      prisma.recurringSchedule.findUnique.mockResolvedValue({
        id: 'schedule-1',
        userId: 'someone-else',
      });

      await expect(
        service.remove(userId, 'schedule-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.recurringSchedule.delete).not.toHaveBeenCalled();
    });
  });
});