import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';



/**
 * AuthService
 *
 * Authentication flow for ChainSettle:
 *  1. Frontend generates a random challenge (nonce) from the server
 *  2. User signs the challenge with their Freighter wallet (Stellar keypair)
 *  3. Backend verifies the signature against the user's Stellar public key
 *  4. On success, issues a JWT for subsequent API calls
 *
 * This is a standard "Sign-In With Stellar" pattern — no password, no email required.
 * The Stellar address IS the identity.
 *
 * NOTE: Full signature verification requires the Stellar SDK's keypair.verify().
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly NONCE_PREFIX = 'chainsettle:nonce:';
  private readonly NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds


  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly auditLog: AuditLogService,
  ) { }

  // ----------------------------------------------------------
  // STEP 1: Generate a challenge nonce for an address
  // ----------------------------------------------------------

  async generateNonce(stellarAddress: string): Promise<string> {
    const nonce = `chainsettle:${stellarAddress}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const key = `${this.NONCE_PREFIX}${stellarAddress}`;

    // Store in Redis with 5-minute expiration using Redis-native TTL
    await this.redis.setPx(key, nonce, this.NONCE_TTL_MS);


    return nonce;
  }

  // ----------------------------------------------------------
  // STEP 2: Verify signed nonce and issue JWT
  // ----------------------------------------------------------

  async login(dto: LoginDto): Promise<{ accessToken: string; user: any }> {
    const { stellarAddress, signedNonce, signature } = dto;

    // Retrieve the stored nonce from Redis
    const key = `${this.NONCE_PREFIX}${stellarAddress}`;
    const storedNonce = await this.redis.get(key);


    if (!storedNonce) {
      throw new UnauthorizedException('Nonce expired or not found. Request a new one.');
    }

    // Verify the signature against the stored nonce.
    let isValid = false;
    try {
      const keypair = Keypair.fromPublicKey(stellarAddress);
      const signatureBuffer = Buffer.from(signature, 'base64');
      isValid = keypair.verify(Buffer.from(storedNonce), signatureBuffer);
    } catch (err) {
      this.logger.warn(`Signature verification failed for ${stellarAddress}`);
      throw new UnauthorizedException('Signature verification failed');
    }

    if (!isValid) {
      throw new UnauthorizedException('Signature verification failed');
    }

    // Clear the nonce — one-time use
    await this.redis.del(key);

    // Upsert user in the database
    const user = await this.prisma.user.upsert({
      where: { stellarAddress },
      create: { stellarAddress },
      update: { updatedAt: new Date() },
    });

    // Sign JWT
    const accessToken = this.jwt.sign({
      sub: user.id,
      stellarAddress: user.stellarAddress,
      role: user.role,
    });

    this.logger.log(`User authenticated: ${stellarAddress}`);
    return { accessToken, user };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stellarAddress: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  async getPublicProfile(stellarAddress: string) {
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress },
      select: { stellarAddress: true, name: true, role: true, createdAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const updateData: any = {};

    if (dto.name !== undefined) {
      updateData.name = dto.name;
    }

    if (dto.email !== undefined && dto.email !== user.email) {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });

      if (existing && existing.id !== userId) {
        throw new ConflictException('Email is already in use');
      }

      const token = this.jwt.sign(
        { sub: userId, email: dto.email },
        { expiresIn: '24h' },
      );

      const verificationLink = `${this.config.get('API_BASE_URL', 'http://localhost:3000')}/api/v1/auth/verify-email?token=${token}`;

      await this.notifications.sendEmail(
        dto.email,
        'Verify your email address',
        `Click this link to verify your email: ${verificationLink}`,
      );

      updateData.pendingEmail = dto.email;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });
    }

    return this.getProfile(userId);
  }

  async updateUserRole(id: string, callerId: string, callerAddress: string, newRole: UserRole) {
    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (id === callerId && newRole !== UserRole.ADMIN) {
      throw new ConflictException('Admins cannot demote themselves');
    }

    const oldRole = user.role;

    await this.prisma.user.update({ where: { id }, data: { role: newRole } });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: 'USER_ROLE_CHANGED',
      resourceType: 'User',
      resourceId: id,
      metadata: { from: oldRole, to: newRole },
    });

    return this.getProfile(id);
  }

  async findAllUsers(filters: {
    role?: UserRole;
    emailVerified?: boolean;
    page?: number;
    limit?: number;
    orderBy?: 'createdAt' | 'name';
  }) {
    const { role, emailVerified, page = 1, limit = 20, orderBy = 'createdAt' } = filters;

    const where: any = {};
    if (role !== undefined) where.role = role;
    if (emailVerified !== undefined) where.emailVerified = emailVerified;

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          stellarAddress: true,
          email: true,
          emailVerified: true,
          name: true,
          role: true,
          createdAt: true,
        },
        orderBy: orderBy === 'name' ? { name: 'asc' } : { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async verifyEmail(token: string) {
    let payload: { sub: string; email: string };
    try {
      payload = this.jwt.verify<{ sub: string; email: string }>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired verification token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.pendingEmail !== payload.email) {
      throw new UnauthorizedException('Verification token does not match pending email');
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: payload.email },
    });

    if (existing && existing.id !== user.id) {
      throw new ConflictException('Email is already in use');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        email: payload.email,
        emailVerified: true,
        pendingEmail: null,
      },
    });

    return { message: 'Email verified successfully' };
  }
}
