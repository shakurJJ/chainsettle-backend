import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto/announcement.dto';

/**
 * Platform announcements (#426): temporary, admin-managed banners.
 *
 * An announcement is active while `startsAt <= now` and (`endsAt` is null or
 * `now < endsAt`), and is shown to a user when `audienceRoles` is empty or
 * contains their role, unless that user has dismissed it.
 */
@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertWindow(startsAt: Date, endsAt: Date | null | undefined) {
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
  }

  async create(dto: CreateAnnouncementDto, createdById?: string) {
    const startsAt = dto.startsAt ?? new Date();
    this.assertWindow(startsAt, dto.endsAt);
    return this.prisma.announcement.create({
      data: {
        title: dto.title.trim(),
        body: dto.body.trim(),
        severity: dto.severity,
        startsAt,
        endsAt: dto.endsAt ?? null,
        audienceRoles: Array.from(new Set(dto.audienceRoles ?? [])),
        createdById,
      },
    });
  }

  async findAll(page = 1, limit = 20) {
    const [data, total] = await Promise.all([
      this.prisma.announcement.findMany({
        orderBy: { startsAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.announcement.count(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
    });
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement;
  }

  async update(id: string, dto: UpdateAnnouncementDto) {
    const existing = await this.findOne(id);
    this.assertWindow(dto.startsAt ?? existing.startsAt, dto.endsAt !== undefined ? dto.endsAt : existing.endsAt);
    return this.prisma.announcement.update({
      where: { id },
      data: {
        title: dto.title?.trim(),
        body: dto.body?.trim(),
        severity: dto.severity,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        audienceRoles: dto.audienceRoles ? Array.from(new Set(dto.audienceRoles)) : undefined,
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.announcement.delete({ where: { id } });
    return { deleted: true };
  }

  /** Active, role-matching announcements the user has not dismissed, most severe first. */
  async findActiveForUser(userId: string, role: UserRole, now: Date = new Date()) {
    const where: Prisma.AnnouncementWhereInput = {
      startsAt: { lte: now },
      AND: [
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        {
          OR: [{ audienceRoles: { isEmpty: true } }, { audienceRoles: { has: role } }],
        },
      ],
      dismissals: { none: { userId } },
    };
    const rows = await this.prisma.announcement.findMany({
      where,
      orderBy: [{ startsAt: 'desc' }],
      select: {
        id: true,
        title: true,
        body: true,
        severity: true,
        startsAt: true,
        endsAt: true,
      },
    });
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
    return rows.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  /** Idempotent: dismissing twice is a no-op. */
  async dismiss(announcementId: string, userId: string) {
    await this.findOne(announcementId);
    await this.prisma.announcementDismissal.upsert({
      where: { announcementId_userId: { announcementId, userId } },
      create: { announcementId, userId },
      update: {},
    });
    return { dismissed: true };
  }
}
