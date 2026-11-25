import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrganizationRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { API_KEY_SCOPES, CreateApiKeyDto } from '../auth/dto/create-api-key.dto';
import { RotateApiKeyDto } from '../auth/dto/rotate-api-key.dto';
import { OrganizationsService } from './organizations.service';

const KEY_SELECT = {
  id: true,
  name: true,
  scopes: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
  userId: true,
  organizationId: true,
} as const;

function newKeyMaterial() {
  const plaintext = randomBytes(20).toString('hex');
  return { plaintext, keyHash: createHash('sha256').update(plaintext).digest('hex') };
}

/**
 * Organization-owned API keys (#647). Keys belong to the org rather than an
 * individual, so they keep working when the creating member leaves. Only org
 * OWNER/ADMIN may manage them; scopes and expiry are enforced exactly as for
 * personal keys by the api-key strategy/guard.
 */
@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('organizations/:id/api-keys')
export class OrganizationApiKeysController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List active organization API keys — requires ADMIN' })
  async list(@Param('id') orgId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.organizations.requireRole(orgId, user.id, OrganizationRole.ADMIN);
    return this.prisma.apiKey.findMany({
      where: { organizationId: orgId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: KEY_SELECT,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an organization API key (plaintext returned once) — requires ADMIN' })
  async create(@Param('id') orgId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApiKeyDto) {
    await this.organizations.requireRole(orgId, user.id, OrganizationRole.ADMIN);
    const { plaintext, keyHash } = newKeyMaterial();
    const key = await this.prisma.apiKey.create({
      data: {
        userId: user.id,
        organizationId: orgId,
        keyHash,
        name: dto.name,
        scopes: dto.scopes ?? [...API_KEY_SCOPES],
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      select: KEY_SELECT,
    });
    return { ...key, key: plaintext };
  }

  @Post(':keyId/rotate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Rotate an organization API key — requires ADMIN' })
  async rotate(
    @Param('id') orgId: string,
    @Param('keyId') keyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RotateApiKeyDto,
  ) {
    await this.organizations.requireRole(orgId, user.id, OrganizationRole.ADMIN);
    const existing = await this.findOrgKey(orgId, keyId);
    if (existing.revokedAt) throw new ConflictException('API_KEY_ALREADY_REVOKED');

    const { plaintext, keyHash } = newKeyMaterial();
    const now = new Date();
    const graceSecs = dto.gracePeriodSeconds ?? 0;
    const gracePeriodEndsAt = graceSecs > 0 ? new Date(now.getTime() + graceSecs * 1000) : null;

    const [, newKey] = await this.prisma.$transaction([
      this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: now, gracePeriodEndsAt } }),
      this.prisma.apiKey.create({
        data: {
          userId: user.id,
          organizationId: orgId,
          keyHash,
          name: existing.name,
          scopes: existing.scopes,
          rotatedFromId: existing.id,
        },
        select: KEY_SELECT,
      }),
    ]);
    return { ...newKey, rotatedFromId: existing.id, gracePeriodEndsAt, key: plaintext };
  }

  @Delete(':keyId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an organization API key — requires ADMIN' })
  async revoke(@Param('id') orgId: string, @Param('keyId') keyId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.organizations.requireRole(orgId, user.id, OrganizationRole.ADMIN);
    const existing = await this.findOrgKey(orgId, keyId);
    if (existing.revokedAt) throw new NotFoundException('API key not found');
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    return { message: 'API key revoked successfully' };
  }

  private async findOrgKey(orgId: string, keyId: string) {
    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!key || key.organizationId !== orgId) throw new NotFoundException('API key not found');
    return key;
  }
}
