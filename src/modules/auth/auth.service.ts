import { Injectable, UnauthorizedException, ConflictException, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { UserRole, ShipmentStatus } from '@prisma/client';
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
  private readonly EMAIL_VERIFICATION_TOKEN_PREFIX = 'chainsettle:email-verification-token:';


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

    if (user.deactivatedAt) {
      throw new UnauthorizedException('Account has been deactivated');
    }

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
        deactivatedAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.deactivatedAt) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    const { deactivatedAt: _deactivatedAt, ...profile } = user;
    return profile;
  }

  /**
   * Soft-deactivate the authenticated user's account.
   * Preserves the User row and all historical relations (shipments, comments, audit logs).
   * Rejects with 409 if the user is still party to any ACTIVE shipment.
   */
  async deactivateUser(userId: string): Promise<{ message: string; deactivatedAt: Date }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stellarAddress: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.deactivatedAt) {
      throw new ConflictException('Account is already deactivated');
    }

    const activeShipmentCount = await this.prisma.shipment.count({
      where: {
        status: ShipmentStatus.ACTIVE,
        OR: [
          { buyerAddress: user.stellarAddress },
          { supplierAddress: user.stellarAddress },
          { logisticsAddress: user.stellarAddress },
          { arbiterAddress: user.stellarAddress },
        ],
      },
    });

    if (activeShipmentCount > 0) {
      throw new ConflictException(
        `Cannot deactivate account while you have ${activeShipmentCount} active shipment(s). ` +
          'Resolve or transfer all ACTIVE shipments where you are buyer, supplier, logistics, or arbiter first.',
      );
    }

    const deactivatedAt = new Date();

    await this.prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt },
    });

    await this.auditLog.record({
      actorId: user.id,
      actorAddress: user.stellarAddress,
      action: 'USER_DEACTIVATED',
      resourceType: 'User',
      resourceId: user.id,
      metadata: { deactivatedAt: deactivatedAt.toISOString() },
    });

    this.logger.log(`User deactivated: ${user.stellarAddress} (${user.id})`);

    return {
      message: 'Account deactivated successfully',
      deactivatedAt,
    };
  }

  /**
   * Admin-only suspension/reversal of a user account. Reuses the
   * deactivatedAt column introduced for self-service deactivation, but
   * skips the active-shipment check (admins may need to suspend accounts
   * mid-shipment for fraud response). Idempotent: setting a user to the
   * state they're already in is a no-op, not an error.
   */
  async adminSetActive(id: string, active: boolean, adminId: string, adminAddress: string) {
    if (!active && id === adminId) {
      throw new BadRequestException(
        'Admins cannot deactivate their own account via this route. Use DELETE /users/me instead.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, stellarAddress: true, deactivatedAt: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isCurrentlyActive = !user.deactivatedAt;
    if (isCurrentlyActive === active) {
      return {
        message: `Account is already ${active ? 'active' : 'deactivated'}`,
        deactivatedAt: user.deactivatedAt,
      };
    }

    const deactivatedAt = active ? null : new Date();

    await this.prisma.user.update({
      where: { id },
      data: { deactivatedAt },
    });

    await this.auditLog.record({
      actorId: adminId,
      actorAddress: adminAddress,
      action: active ? 'ADMIN_USER_REACTIVATED' : 'ADMIN_USER_DEACTIVATED',
      resourceType: 'User',
      resourceId: id,
      metadata: { targetUserId: id, targetStellarAddress: user.stellarAddress },
    });

    this.logger.log(
      `User ${user.stellarAddress} (${id}) ${active ? 'reactivated' : 'deactivated'} by admin ${adminId}`,
    );

    return {
      message: `Account ${active ? 'reactivated' : 'deactivated'} successfully`,
      deactivatedAt,
    };
  }

  /**
   * Full admin detail view of a single user: the raw User record plus
   * operational counts, computed via parallel aggregate queries (no N+1).
   */
  async getAdminUserDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        stellarAddress: true,
        email: true,
        emailVerified: true,
        pendingEmail: true,
        name: true,
        role: true,
        deactivatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [shipmentCount, activeApiKeyCount, webhookCount, unreadNotificationCount] = await Promise.all([
      this.prisma.shipment.count({
        where: {
          OR: [
            { buyerAddress: user.stellarAddress },
            { supplierAddress: user.stellarAddress },
            { logisticsAddress: user.stellarAddress },
            { arbiterAddress: user.stellarAddress },
          ],
        },
      }),
      this.prisma.apiKey.count({ where: { userId: id, revokedAt: null } }),
      this.prisma.webhookEndpoint.count({ where: { userId: id } }),
      this.prisma.notification.count({ where: { userId: id, read: false } }),
    ]);

    return {
      ...user,
      shipmentCount,
      activeApiKeyCount,
      webhookCount,
      unreadNotificationCount,
    };
  }

  async getPublicProfile(stellarAddress: string) {
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress },
      select: { stellarAddress: true, name: true, role: true, createdAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Issue a short-lived impersonation JWT so an admin can call the API as a target user.
   * The token embeds impersonatorAdminId / isImpersonation for audit and guard enforcement.
   */
  async impersonateUser(
    targetUserId: string,
    adminId: string,
    adminAddress: string,
    ipAddress?: string,
  ): Promise<{
    accessToken: string;
    expiresIn: string;
    targetUser: { id: string; stellarAddress: string; role: UserRole; name: string | null };
  }> {
    if (targetUserId === adminId) {
      throw new BadRequestException('Cannot impersonate your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        stellarAddress: true,
        role: true,
        name: true,
        deactivatedAt: true,
      },
    });

    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (target.deactivatedAt) {
      throw new ForbiddenException('Cannot impersonate a deactivated user');
    }

    if (target.role === UserRole.ADMIN) {
      throw new ForbiddenException('Cannot impersonate another admin');
    }

    const expiresIn = this.config.get<string>('IMPERSONATION_JWT_EXPIRES_IN', '15m');

    const accessToken = this.jwt.sign(
      {
        sub: target.id,
        stellarAddress: target.stellarAddress,
        role: target.role,
        isImpersonation: true,
        impersonatorAdminId: adminId,
        impersonatorAddress: adminAddress,
      },
      { expiresIn },
    );

    await this.auditLog.record({
      actorId: adminId,
      actorAddress: adminAddress,
      action: 'admin.impersonate',
      resourceType: 'User',
      resourceId: target.id,
      metadata: {
        targetUserId: target.id,
        targetStellarAddress: target.stellarAddress,
        targetRole: target.role,
        expiresIn,
      },
      ipAddress,
    });

    this.logger.warn(
      `Admin ${adminId} (${adminAddress}) started impersonating user ${target.id} (${target.stellarAddress})`,
    );

    return {
      accessToken,
      expiresIn,
      targetUser: {
        id: target.id,
        stellarAddress: target.stellarAddress,
        role: target.role,
        name: target.name,
      },
    };
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

      await this.sendVerificationEmail(userId, dto.email);

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

    const storedToken = await this.redis.get(this.getVerificationTokenKey(payload.sub));
    if (!storedToken || storedToken !== token) {
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

    await this.redis.del(this.getVerificationTokenKey(user.id));

    return { message: 'Email verified successfully' };
  }

  async resendVerificationEmail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, pendingEmail: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.pendingEmail) {
      throw new BadRequestException('No pending email to verify');
    }

    return this.sendVerificationEmail(user.id, user.pendingEmail);
  }

  private getVerificationTokenKey(userId: string) {
    return `${this.EMAIL_VERIFICATION_TOKEN_PREFIX}${userId}`;
  }

  private async sendVerificationEmail(userId: string, email: string) {
    const token = this.jwt.sign(
      { sub: userId, email },
      { expiresIn: '24h' },
    );

    await this.redis.setPx(this.getVerificationTokenKey(userId), token, 24 * 60 * 60 * 1000);

    const verificationLink = `${this.config.get('API_BASE_URL', 'http://localhost:3000')}/api/v1/auth/verify-email?token=${token}`;

    await this.notifications.sendEmail(
      email,
      'Verify your email address',
      `Click this link to verify your email: ${verificationLink}`,
    );

    return { message: 'Verification email sent' };
  }
}
