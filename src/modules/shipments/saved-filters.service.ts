import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Filter fields that may be stored in a preset.
 *
 * Anything outside this list is rejected rather than persisted, so a saved
 * filter can never smuggle an arbitrary key into the query the list endpoint
 * builds.
 *
 * Pagination (page, limit, cursor) is deliberately excluded: it is a
 * per-request concern, and baking a page number into a saved view would mean
 * recalling the view always landed on the same page.
 */
export const SAVED_FILTER_FIELDS = [
  'buyerAddress',
  'supplierAddress',
  'status',
  'referenceNumber',
  'tags',
  'search',
  'createdAfter',
  'createdBefore',
  'updatedAfter',
  'updatedBefore',
  'includeArchived',
  'isDraft',
  'favorite',
] as const;

export type SavedFilterCriteria = Partial<
  Record<(typeof SAVED_FILTER_FIELDS)[number], unknown>
>;

/**
 * Named, reusable GET /shipments filter presets.
 *
 * Every read and write is scoped by userId, so a preset is private to the user
 * who created it and an id belonging to somebody else is indistinguishable
 * from one that does not exist.
 */
@Injectable()
export class SavedFiltersService {
  private readonly logger = new Logger(SavedFiltersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Keep only recognised filter fields, rejecting anything else.
   *
   * Unknown keys are an error rather than being dropped silently: a caller who
   * saves a filter with a typo should hear about it, not discover later that
   * the preset quietly matches more than they intended.
   */
  private sanitise(filter: Record<string, unknown>): SavedFilterCriteria {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new BadRequestException('filter must be an object');
    }

    const allowed = new Set<string>(SAVED_FILTER_FIELDS);
    const unknown = Object.keys(filter).filter((k) => !allowed.has(k));

    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unsupported filter field(s): ${unknown.join(', ')}. ` +
          `Supported fields are: ${SAVED_FILTER_FIELDS.join(', ')}.`,
      );
    }

    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(filter)) {
      if (filter[key] !== undefined && filter[key] !== null) {
        clean[key] = filter[key];
      }
    }

    if (Object.keys(clean).length === 0) {
      throw new BadRequestException('filter must contain at least one criterion');
    }

    return clean as SavedFilterCriteria;
  }

  /** Save a new preset for a user. */
  async create(userId: string, name: string, filter: Record<string, unknown>) {
    const criteria = this.sanitise(filter);

    const existing = await this.prisma.savedFilter.findFirst({
      where: { userId, name },
    });

    if (existing) {
      throw new ConflictException(
        `You already have a saved filter named "${name}"`,
      );
    }

    const saved = await this.prisma.savedFilter.create({
      data: { userId, name, filter: criteria as object },
    });

    this.logger.log(`Saved filter "${name}" created for user ${userId}`);
    return saved;
  }

  /** Every preset belonging to a user, newest first. */
  async findAll(userId: string) {
    return this.prisma.savedFilter.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * A single preset belonging to a user.
   *
   * Scoped by userId, so another user's id yields a 404 rather than a 403:
   * a preset's existence is itself private.
   */
  async findOne(userId: string, id: string) {
    const saved = await this.prisma.savedFilter.findFirst({
      where: { id, userId },
    });

    if (!saved) {
      throw new NotFoundException(`Saved filter ${id} not found`);
    }

    return saved;
  }

  /** Rename a preset, replace its criteria, or both. */
  async update(
    userId: string,
    id: string,
    updates: { name?: string; filter?: Record<string, unknown> },
  ) {
    await this.findOne(userId, id);

    if (updates.name !== undefined) {
      const clash = await this.prisma.savedFilter.findFirst({
        where: { userId, name: updates.name, NOT: { id } },
      });
      if (clash) {
        throw new ConflictException(
          `You already have a saved filter named "${updates.name}"`,
        );
      }
    }

    return this.prisma.savedFilter.update({
      where: { id },
      data: {
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.filter !== undefined
          ? { filter: this.sanitise(updates.filter) as object }
          : {}),
      },
    });
  }

  /** Delete a preset. Scoped by userId, so one user cannot delete another's. */
  async remove(userId: string, id: string) {
    await this.findOne(userId, id);
    await this.prisma.savedFilter.delete({ where: { id } });
    this.logger.log(`Saved filter ${id} deleted by user ${userId}`);
    return { deleted: true, id };
  }

  /**
   * Merge a stored preset underneath the query params of the current request.
   *
   * Explicit query params win. A saved view is a starting point, so
   * `?savedFilterId=x&status=DISPUTED` narrows that view to DISPUTED rather
   * than being overridden by whatever status the preset happened to store.
   *
   * Only keys the caller actually supplied count as explicit; undefined values
   * left on the parsed DTO do not mask the preset.
   */
  async applyTo<T extends object>(
    userId: string,
    savedFilterId: string,
    query: T,
  ): Promise<T> {
    const saved = await this.findOne(userId, savedFilterId);
    const criteria = (saved.filter ?? {}) as Record<string, unknown>;

    const asRecord = query as Record<string, unknown>;
    const explicit: Record<string, unknown> = {};
    for (const key of Object.keys(asRecord)) {
      if (asRecord[key] !== undefined) explicit[key] = asRecord[key];
    }

    return { ...criteria, ...explicit } as unknown as T;
  }
}
