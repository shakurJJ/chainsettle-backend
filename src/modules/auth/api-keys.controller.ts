import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { randomBytes, createHash } from 'crypto';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { CreateApiKeyDto, API_KEY_SCOPES } from './dto/create-api-key.dto';
import { ApiKeyResponseDto } from './dto/api-key-response.dto';
import { RotateApiKeyDto } from './dto/rotate-api-key.dto';
import { RedisService } from '../../common/redis/redis.service';
import { API_KEY_USAGE_PREFIX } from './api-key.strategy';

@ApiTags('Auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/api-keys')
export class ApiKeysController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly redis: RedisService,
  ) {}

  // ----------------------------------------------------------
  // GET /auth/api-keys
  // Lists all active (non-revoked) keys belonging to the caller
  // ----------------------------------------------------------
  @Get()
  @ApiOperation({ summary: 'List your API keys' })
  @ApiResponse({
    status: 200,
    description: 'Returns all non-revoked API keys for the caller, including scopes and expiry.',
    type: [ApiKeyResponseDto],
  })
  async list(@CurrentUser() user: { id: string }) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return keys;
  }

  // ----------------------------------------------------------
  // POST /auth/api-keys
  // Generates a new API key — plaintext returned only once
  // ----------------------------------------------------------
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate a new API key (plaintext returned once)' })
  @ApiResponse({
    status: 201,
    description:
      'Key created. Save the plaintext key — it will not be shown again. ' +
      'Omit `scopes` for full access (["read","write"]); pass ["read"] for a read-only key.',
    type: ApiKeyResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed — invalid scope value or bad expiry date.',
  })
  async create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateApiKeyDto,
  ) {
    const plaintext = randomBytes(20).toString('hex'); // 40 hex chars
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    // Default to full access when the caller omits scopes
    const scopes: string[] = dto.scopes ?? [...API_KEY_SCOPES];

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId: user.id,
        keyHash,
        name: dto.name,
        scopes,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      // Only time the plaintext is ever returned
      key: plaintext,
    };
  }

  // ----------------------------------------------------------
  // POST /auth/api-keys/:id/rotate
  // Atomically revokes the old key and creates a replacement
  // with the same name, userId, and scopes. Optionally keeps
  // the old key valid for gracePeriodSeconds to allow zero-
  // downtime key swaps.
  // ----------------------------------------------------------
  @Post(':id/rotate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Rotate an API key',
    description:
      'Atomically revokes the specified key and issues a replacement key ' +
      'with the same name and scopes. The new plaintext key is returned once — ' +
      'store it immediately. Pass `gracePeriodSeconds` (max 86 400 / 24 h) to ' +
      'keep the old key working during a transition window.',
  })
  @ApiParam({ name: 'id', description: 'UUID of the API key to rotate' })
  @ApiResponse({
    status: 201,
    description:
      'Rotation successful. New plaintext key returned once. ' +
      'Old key is immediately revoked (or revoked after the grace period if provided).',
    type: ApiKeyResponseDto,
  })
  @ApiResponse({ status: 404, description: 'API key not found or not owned by caller.' })
  @ApiResponse({ status: 409, description: 'API_KEY_ALREADY_REVOKED — cannot rotate a revoked key.' })
  async rotate(
    @CurrentUser() user: { id: string; stellarAddress?: string },
    @Param('id') id: string,
    @Body() dto: RotateApiKeyDto,
    @Req() req: Request,
  ) {
    // ── 1. Load and validate the existing key ──────────────────────────────
    const existing = await this.prisma.apiKey.findUnique({ where: { id } });

    // Return 404 (not 403) even for ownership mismatches to avoid enumeration.
    if (!existing || existing.userId !== user.id) {
      throw new NotFoundException('API key not found');
    }

    if (existing.revokedAt !== null) {
      throw new ConflictException('API_KEY_ALREADY_REVOKED');
    }

    // ── 2. Build the new key material ──────────────────────────────────────
    const plaintext = randomBytes(20).toString('hex'); // 40 hex chars
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const now = new Date();

    // Grace period: how long the OLD key remains usable
    const graceSecs = dto.gracePeriodSeconds ?? 0;
    const gracePeriodEndsAt =
      graceSecs > 0 ? new Date(now.getTime() + graceSecs * 1000) : null;

    // ── 3. Atomic transaction: revoke old, create new ──────────────────────
    const [, newKey] = await this.prisma.$transaction([
      // Revoke the old key; set gracePeriodEndsAt so the strategy still
      // accepts it until the window expires.
      this.prisma.apiKey.update({
        where: { id },
        data: {
          revokedAt: now,
          gracePeriodEndsAt,
        },
      }),
      // Create the replacement — inherits name, scopes, and userId from predecessor.
      this.prisma.apiKey.create({
        data: {
          userId: existing.userId,
          keyHash,
          name: existing.name,
          scopes: existing.scopes,
          rotatedFromId: existing.id,
          // Do not inherit expiresAt — integrators should re-specify it explicitly.
        },
      }),
    ]);

    // ── 4. Audit log ───────────────────────────────────────────────────────
    // Fire-and-forget so a logging hiccup never fails the rotation itself.
    this.auditLog
      .record({
        actorId: user.id,
        actorAddress: user.stellarAddress ?? '',
        action: 'API_KEY_ROTATED',
        resourceType: 'api_key',
        resourceId: newKey.id,
        metadata: {
          oldKeyId: existing.id,
          newKeyId: newKey.id,
          gracePeriodSeconds: graceSecs,
          gracePeriodEndsAt: gracePeriodEndsAt?.toISOString() ?? null,
        },
        ipAddress:
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ??
          req.socket?.remoteAddress,
      })
      .catch(() => null);

    // ── 5. Return the new key (plaintext shown once) ───────────────────────
    return {
      id: newKey.id,
      name: newKey.name,
      scopes: newKey.scopes,
      expiresAt: newKey.expiresAt,
      createdAt: newKey.createdAt,
      rotatedFromId: newKey.rotatedFromId,
      gracePeriodEndsAt,
      // Single-use plaintext — not stored, not retrievable again
      key: plaintext,
    };
  }

  // ----------------------------------------------------------
  // DELETE /auth/api-keys/:id
  // Revokes a key by setting revokedAt = now()
  // ----------------------------------------------------------
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 200, description: 'Key revoked successfully.' })
  @ApiResponse({ status: 404, description: 'API key not found.' })
  @ApiResponse({ status: 403, description: 'You do not own this key.' })
  async revoke(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const apiKey = await this.prisma.apiKey.findUnique({ where: { id } });

    if (!apiKey || apiKey.revokedAt !== null) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.userId !== user.id) {
      throw new ForbiddenException('You do not own this API key');
    }

    await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    return { message: 'API key revoked successfully' };
  }

  // ----------------------------------------------------------
  // GET /auth/api-keys/:id/usage
  // Returns daily request stats for the last 30 days and lastUsedAt.
  // Owner-only.
  // ----------------------------------------------------------
  @Get(':id/usage')
  @ApiOperation({ summary: 'Get daily request usage stats for an API key (owner-only)' })
  @ApiParam({ name: 'id', description: 'UUID of the API key' })
  @ApiResponse({
    status: 200,
    description: 'Returns 30-day daily request stats and lastUsedAt timestamp.',
  })
  @ApiResponse({ status: 404, description: 'API key not found.' })
  @ApiResponse({ status: 403, description: 'You do not own this API key.' })
  async getUsage(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        lastUsedAt: true,
      },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.userId !== user.id) {
      throw new ForbiddenException('You do not own this API key');
    }

    const days = 30;
    const now = new Date();
    const dates: string[] = [];
    const keys: string[] = [];

    // Chronological order: 29 days ago up to today
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      dates.push(dateStr);
      keys.push(`${API_KEY_USAGE_PREFIX}${id}:${dateStr}`);
    }

    const counts = await this.redis.getClient().mget(...keys);

    let totalRequests = 0;
    const dailyUsage = dates.map((date, idx) => {
      const rawCount = counts[idx];
      const count = rawCount ? parseInt(rawCount, 10) : 0;
      totalRequests += count;
      return { date, count };
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      lastUsedAt: apiKey.lastUsedAt,
      totalRequests30d: totalRequests,
      dailyUsage,
    };
  }
}
