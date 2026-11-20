import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SiwsService } from '../auth/siws.service';
import { UsersService } from './users.service';
import { LinkedAddress } from './linked-address.entity';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

interface LinkAddressDto {
  address: string;
  message: string;
  signature: string;
}

interface UpdateProfileDto {
  timezone?: string;
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly siwsService: SiwsService,
  ) {}

  @Patch('me')
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ): Promise<{ success: boolean; timezone: string }> {
    if (dto.timezone !== undefined) {
      if (!this.usersService.isValidTimezone(dto.timezone)) {
        throw new HttpException('Invalid IANA timezone', HttpStatus.BAD_REQUEST);
      }
    }

    const timezone = await this.usersService.updateTimezone(req.user.id, dto.timezone);
    return { success: true, timezone };
  }

  @Get('me/addresses')
  async listAddresses(@Req() req: AuthenticatedRequest): Promise<LinkedAddress[]> {
    return this.usersService.listLinkedAddresses(req.user.id);
  }

  @Post('me/addresses')
  async linkAddress(
    @Req() req: AuthenticatedRequest,
    @Body() dto: LinkAddressDto,
  ): Promise<LinkedAddress> {
    const verified = await this.siwsService.verify(dto.message, dto.signature, dto.address);
    if (!verified) {
      throw new HttpException('Invalid SIWS signature', HttpStatus.UNAUTHORIZED);
    }

    const existing = await this.usersService.findLinkedAddressByAddress(dto.address);
    if (existing && existing.userId !== req.user.id) {
      throw new HttpException(
        'Address is already linked to another user',
        HttpStatus.CONFLICT,
      );
    }
    if (existing) {
      return existing;
    }

    return this.usersService.linkAddress(req.user.id, dto.address);
  }

  @Delete('me/addresses/:address')
  async unlinkAddress(
    @Req() req: AuthenticatedRequest,
    @Param('address') address: string,
  ): Promise<{ success: boolean }> {
    const linked = await this.usersService.findLinkedAddressByAddress(address);
    if (!linked || linked.userId !== req.user.id) {
      throw new HttpException('Address not linked to this user', HttpStatus.NOT_FOUND);
    }
    if (linked.isPrimary) {
      throw new HttpException(
        'Cannot unlink the primary address',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.usersService.unlinkAddress(req.user.id, address);
    return { success: true };
  }

  @Delete('me')
  async deactivate(@Req() req: AuthenticatedRequest): Promise<{ success: boolean; deactivatedAt: Date }> {
    const deactivatedAt = await this.usersService.deactivateAccount(req.user.id);
    return { success: true, deactivatedAt };
  }

  @Post('me/restore')
  async restore(@Req() req: AuthenticatedRequest): Promise<{ success: boolean }> {
    const restored = await this.usersService.restoreAccount(req.user.id);
    if (!restored) {
      throw new HttpException(
        'Account cannot be restored: grace period has expired',
        HttpStatus.GONE,
      );
    }
    return { success: true };
  }
}
