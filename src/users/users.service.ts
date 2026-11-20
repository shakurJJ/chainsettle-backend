import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LinkedAddress } from './linked-address.entity';
import { User } from './user.entity';
import { SiwsService } from '../auth/siws.service';

export interface LinkAddressDto {
  address: string;
  challenge: string;
  signature: string;
}

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

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === '23505'
    );
  }
}
