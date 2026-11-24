import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { LinkedAddress } from './linked-address.entity';
import { User } from './user.entity';
import { SiwsService } from '../auth/siws.service';

export interface LinkAddressDto {
  address: string;
  challenge: string;
  signature: string;
}

export interface UpdateProfileDto {
  timezone?: string;
}

const DEFAULT_GRACE_PERIOD_DAYS = 30;
const DEFAULT_TIMEZONE = 'UTC';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(LinkedAddress)
    private readonly linkedAddressRepository: Repository<LinkedAddress>,
    private readonly siwsService: SiwsService,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByAddress(address: string): Promise<User | null> {
    const linked = await this.linkedAddressRepository.findOne({
      where: { address },
      relations: ['user'],
    });
    return linked?.user ?? null;
  }

  async getLinkedAddresses(userId: string): Promise<LinkedAddress[]> {
    return this.linkedAddressRepository.find({
      where: { userId },
      order: { isPrimary: 'DESC', createdAt: 'ASC' },
    });
  }

  async linkAddress(userId: string, dto: LinkAddressDto): Promise<LinkedAddress> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const proven = await this.siwsService.verifyChallenge(
      dto.challenge,
      dto.signature,
      dto.address,
    );
    if (!proven) {
      throw new BadRequestException('Invalid SIWS proof of ownership');
    }

    const existing = await this.linkedAddressRepository.findOne({
      where: { address: dto.address },
    });
    if (existing) {
      if (existing.userId === userId) {
        return existing;
      }
      throw new ConflictException('Address is already linked to another user');
    }

    const count = await this.linkedAddressRepository.count({
      where: { userId },
    });

    const linked = this.linkedAddressRepository.create({
      userId,
      address: dto.address,
      isPrimary: count === 0,
    });

    try {
      return await this.linkedAddressRepository.save(linked);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Address is already linked to another user');
      }
      throw error;
    }
  }

  async unlinkAddress(userId: string, address: string): Promise<void> {
    const linked = await this.linkedAddressRepository.findOne({
      where: { userId, address },
    });
    if (!linked) {
      throw new NotFoundException('Linked address not found');
    }
    if (linked.isPrimary) {
      throw new BadRequestException('Cannot unlink the primary address');
    }
    await this.linkedAddressRepository.remove(linked);
  }

  async hasAddressAccess(userId: string, address: string): Promise<boolean> {
    const linked = await this.linkedAddressRepository.findOne({
      where: { userId, address },
    });
    return linked !== null;
  }

  /**
   * Updates the current user's profile. The timezone must be a valid IANA
   * timezone name; invalid values are rejected before persisting.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.timezone !== undefined) {
      if (!this.isValidTimezone(dto.timezone)) {
        throw new BadRequestException('Invalid IANA timezone');
      }
      user.timezone = dto.timezone;
    }

    return this.usersRepository.save(user);
  }

  /**
   * Resolves the user's timezone, falling back to UTC when unset.
   */
  getUserTimezone(user: Pick<User, 'timezone'>): string {
    return user.timezone || DEFAULT_TIMEZONE;
  }

  private isValidTimezone(timezone: string): boolean {
    if (typeof timezone !== 'string' || timezone.length === 0) {
      return false;
    }
    try {
      // Throws RangeError for unknown IANA timezone names.
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deactivates an account and records when it happened so it can be
   * restored within the grace period before PII is anonymised.
   */
  async deactivate(userId: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.deactivatedAt) {
      return user;
    }
    user.deactivatedAt = new Date();
    return this.usersRepository.save(user);
  }

  /**
   * Reactivates a deactivated account only while it is still inside the
   * grace window. Accounts past the window are treated as purged.
   */
  async restore(userId: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.deactivatedAt) {
      throw new BadRequestException('Account is not deactivated');
    }
    if (this.isPastGracePeriod(user.deactivatedAt)) {
      throw new BadRequestException('Grace period has expired');
    }
    user.deactivatedAt = null;
    return this.usersRepository.save(user);
  }

  /**
   * Anonymises PII for accounts whose grace period has elapsed. Shipment
   * records are left intact because they reference the user by id only.
   */
  async purgeExpiredAccounts(): Promise<number> {
    const cutoff = this.graceCutoff();
    const expired = await this.usersRepository.find({
      where: { deactivatedAt: LessThan(cutoff) },
    });

    for (const user of expired) {
      user.email = `deleted-${user.id}@anonymised.invalid`;
      user.displayName = null;
      user.deactivatedAt = null;
      user.anonymisedAt = new Date();
      await this.usersRepository.save(user);
    }

    return expired.length;
  }

  private isPastGracePeriod(deactivatedAt: Date): boolean {
    return deactivatedAt.getTime() < this.graceCutoff().getTime();
  }

  private graceCutoff(): Date {
    const days = this.gracePeriodDays();
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private gracePeriodDays(): number {
    const raw = Number(process.env.ACCOUNT_GRACE_PERIOD_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GRACE_PERIOD_DAYS;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === '23505'
    );
  }
}
