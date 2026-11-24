import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ArbiterReputation, ArbitersService } from './arbiters.service';
import { ArbiterDirectoryQueryDto } from './dto/arbiter-directory-query.dto';
import { UpdateDirectoryProfileDto } from './dto/update-directory-profile.dto';

export interface ArbiterDirectoryEntry {
  address: string;
  name: string | null;
  organization: string | null;
  available: boolean;
  resolvedDisputes: number;
  reputation: {
    score: number | null;
    disputesHandled: number;
    disputesOpen: number;
    averageResolutionTimeHours: number | null;
    hasHistory: boolean;
  };
}

/**
 * Reputation score 0-100: the share of an arbiter's disputes that have been
 * resolved. `null` when the arbiter has no dispute history yet.
 */
export function reputationScore(rep: Pick<ArbiterReputation, 'disputesHandled' | 'disputesOpen'>): number | null {
  const total = rep.disputesHandled + rep.disputesOpen;
  if (total === 0) return null;
  return Math.round((rep.disputesHandled / total) * 100);
}

/**
 * Public arbiter directory (#398). Only users with the ARBITER role who have
 * not opted out (and are not deactivated) are listed, and only public profile
 * fields are selected — never email, KYC status or KYC reference.
 */
@Injectable()
export class ArbiterDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arbiters: ArbitersService,
  ) {}

  async list(query: ArbiterDirectoryQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.UserWhereInput = {
      role: UserRole.ARBITER,
      listedInDirectory: true,
      deactivatedAt: null,
    };
    if (query.available !== undefined) where.arbiterAvailable = query.available;
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { organization: { contains: q, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        stellarAddress: true,
        name: true,
        organization: true,
        arbiterAvailable: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const entries: ArbiterDirectoryEntry[] = await Promise.all(
      users.map(async (u) => {
        const rep = await this.arbiters.getReputation(u.stellarAddress);
        return {
          address: u.stellarAddress,
          name: u.name,
          organization: u.organization,
          available: u.arbiterAvailable,
          resolvedDisputes: rep.disputesHandled,
          reputation: {
            score: reputationScore(rep),
            disputesHandled: rep.disputesHandled,
            disputesOpen: rep.disputesOpen,
            averageResolutionTimeHours: rep.averageResolutionTimeHours,
            hasHistory: rep.hasHistory,
          },
        };
      }),
    );

    const filtered =
      query.minScore === undefined
        ? entries
        : entries.filter((e) => e.reputation.score !== null && e.reputation.score >= query.minScore!);

    // Highest score first; arbiters without history last.
    filtered.sort((a, b) => (b.reputation.score ?? -1) - (a.reputation.score ?? -1));

    const total = filtered.length;
    const start = (page - 1) * limit;
    return {
      data: filtered.slice(start, start + limit),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateOwnProfile(userId: string, dto: UpdateDirectoryProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== UserRole.ARBITER) {
      throw new ForbiddenException('Only arbiters have a directory profile');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        listedInDirectory: dto.listedInDirectory,
        arbiterAvailable: dto.available,
        organization: dto.organization?.trim() || (dto.organization === undefined ? undefined : null),
      },
      select: {
        listedInDirectory: true,
        arbiterAvailable: true,
        organization: true,
      },
    });
    return {
      listedInDirectory: updated.listedInDirectory,
      available: updated.arbiterAvailable,
      organization: updated.organization,
    };
  }
}
