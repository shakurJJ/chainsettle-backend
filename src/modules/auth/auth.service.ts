import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  PayloadTooLargeException,
  Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { UserRole, ShipmentStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { RedisService } from "../../common/redis/redis.service";
import { IpfsService } from "../../common/ipfs/ipfs.service";
import { LoginDto } from "./dto/login.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditLogService } from "../audit-logs/audit-log.service";
import { SessionService } from "./session.service";
import { ForceLogoutDto } from "./dto/force-logout.dto";
import { maskIpAddress } from "../../common/utils/ip.util";

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
  private readonly NONCE_PREFIX = "chainsettle:nonce:";
  private readonly NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
  private readonly EMAIL_VERIFICATION_TOKEN_PREFIX =
    "chainsettle:email-verification-token:";
  private readonly PHONE_OTP_PREFIX = "chainsettle:phone-otp:";
  private readonly PHONE_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes for OTP
  private readonly PHONE_OTP_LENGTH = 6;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly auditLog: AuditLogService,
    private readonly sessions: SessionService,
    @Optional() private readonly ipfs?: IpfsService,
  ) {}

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

  async login(
    dto: LoginDto,
    userAgent = "unknown",
    ipAddress = "unknown",
  ): Promise<{ accessToken: string; user: any }> {
    const { stellarAddress, signedNonce, signature } = dto;

    // Retrieve the stored nonce from Redis
    const key = `${this.NONCE_PREFIX}${stellarAddress}`;
    const storedNonce = await this.redis.get(key);

    if (!storedNonce) {
      throw new UnauthorizedException(
        "Nonce expired or not found. Request a new one.",
      );
    }

    // Verify the signature against the stored nonce.
    let isValid = false;
    try {
      const keypair = Keypair.fromPublicKey(stellarAddress);
      const signatureBuffer = Buffer.from(signature, "base64");
      isValid = keypair.verify(Buffer.from(storedNonce), signatureBuffer);
    } catch (err) {
      this.logger.warn(`Signature verification failed for ${stellarAddress}`);
      await this.recordFailedLoginIfKnownUser(
        stellarAddress,
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException("Signature verification failed");
    }

    if (!isValid) {
      await this.recordFailedLoginIfKnownUser(
        stellarAddress,
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException("Signature verification failed");
    }

    // Clear the nonce — one-time use
    await this.redis.del(key);

    // Upsert user in the database
    const user = await this.prisma.user.upsert({
      where: { stellarAddress },
      create: { stellarAddress },
      update: { updatedAt: new Date() },
    });

    // Sign JWT — embed a unique jti so this session can be individually revoked
    const jti = randomUUID();
    const accessToken = this.jwt.sign({
      sub: user.id,
      stellarAddress: user.stellarAddress,
      role: user.role,
      jti,
    });

    // Track this session in Redis so revoke-all can enumerate it
    await this.sessions.registerSession(user.id, jti);

    // Record successful login in audit log
    await this.auditLog.record({
      actorId: user.id,
      actorAddress: user.stellarAddress,
      action: "LOGIN_SUCCESS",
      resourceType: "User",
      resourceId: user.id,
      metadata: {
        userAgent,
        sessionId: jti,
      },
      ipAddress,
    });

    this.logger.log(`User authenticated: ${stellarAddress}`);
    return { accessToken, user };
  }

  private async recordFailedLoginIfKnownUser(
    stellarAddress: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<void> {
    try {
      const existingUser = await this.prisma.user.findUnique({
        where: { stellarAddress },
        select: { id: true, stellarAddress: true },
      });
      if (existingUser) {
        await this.auditLog.record({
          actorId: existingUser.id,
          actorAddress: existingUser.stellarAddress,
          action: "LOGIN_FAILED",
          resourceType: "User",
          resourceId: existingUser.id,
          metadata: {
            userAgent,
            reason: "Signature verification failed",
          },
          ipAddress,
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to record LOGIN_FAILED audit log: ${error.message}`,
      );
    }
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
        displayCurrency: true,
        locale: true,
        avatarCid: true,
        deactivatedAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (user.deactivatedAt) {
      throw new UnauthorizedException("Account has been deactivated");
    }

    const { deactivatedAt: _deactivatedAt, ...profile } = user;
    return {
      ...profile,
      avatarUrl: profile.avatarCid ? `/api/v1/ipfs/${profile.avatarCid}` : null,
    };
  }

  /**
   * Invalidate the current session so the token is immediately rejected.
   * `jti` is the sessionId embedded in the JWT at login time.
   * `exp` is the JWT expiry epoch (seconds) so we can compute remaining TTL.
   */
  async logout(
    userId: string,
    jti: string,
    exp: number,
  ): Promise<{ message: string }> {
    const nowMs = Date.now();
    const expiryMs = exp * 1000;
    const remainingMs = Math.max(0, expiryMs - nowMs);

    await this.sessions.invalidateSession(userId, jti, remainingMs);
    return { message: "Logged out successfully" };
  }

  /**
   * Return all active sessions for the authenticated user.
   * Raw token values are never returned — only opaque metadata.
   */
  async getSessions(userId: string) {
    return this.sessions.listSessions(userId);
  }

  /**
   * Revoke a single active session owned by the authenticated user.
   * The session record is deleted and its JWT is added to the blocklist
   * so future requests with that token are rejected.
   */
  async revokeSession(
    userId: string,
    sessionId: string,
  ): Promise<{ message: string }> {
    const revoked = await this.sessions.revokeSession(userId, sessionId);

    if (!revoked) {
      throw new NotFoundException("Session not found");
    }

    return { message: "Session revoked successfully" };
  }

  /**
   * Soft-deactivate the authenticated user's account.
   * Preserves the User row and all historical relations (shipments, comments, audit logs).
   * Rejects with 409 if the user is still party to any ACTIVE shipment.
   */
  async deactivateUser(
    userId: string,
  ): Promise<{ message: string; deactivatedAt: Date }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stellarAddress: true,
        deactivatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (user.deactivatedAt) {
      throw new ConflictException("Account is already deactivated");
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
          "Resolve or transfer all ACTIVE shipments where you are buyer, supplier, logistics, or arbiter first.",
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
      action: "USER_DEACTIVATED",
      resourceType: "User",
      resourceId: user.id,
      metadata: { deactivatedAt: deactivatedAt.toISOString() },
    });

    this.logger.log(`User deactivated: ${user.stellarAddress} (${user.id})`);

    return {
      message: "Account deactivated successfully",
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
  async adminSetActive(
    id: string,
    active: boolean,
    adminId: string,
    adminAddress: string,
  ) {
    if (!active && id === adminId) {
      throw new BadRequestException(
        "Admins cannot deactivate their own account via this route. Use DELETE /users/me instead.",
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, stellarAddress: true, deactivatedAt: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const isCurrentlyActive = !user.deactivatedAt;
    if (isCurrentlyActive === active) {
      return {
        message: `Account is already ${active ? "active" : "deactivated"}`,
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
      action: active ? "ADMIN_USER_REACTIVATED" : "ADMIN_USER_DEACTIVATED",
      resourceType: "User",
      resourceId: id,
      metadata: { targetUserId: id, targetStellarAddress: user.stellarAddress },
    });

    this.logger.log(
      `User ${user.stellarAddress} (${id}) ${active ? "reactivated" : "deactivated"} by admin ${adminId}`,
    );

    return {
      message: `Account ${active ? "reactivated" : "deactivated"} successfully`,
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
        organizationName: true,
        countryCode: true,
        deactivatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const [
      shipmentCount,
      activeApiKeyCount,
      webhookCount,
      unreadNotificationCount,
    ] = await Promise.all([
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

  /**
   * GDPR/CCPA data-portability export: aggregates everything owned by this
   * user across the system. Only the caller's own records are returned —
   * shipment rows include counterparties' Stellar addresses (already
   * public) but never their name/email, since those are never joined in.
   */
  async exportUserData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stellarAddress: true,
        email: true,
        emailVerified: true,
        name: true,
        role: true,
        organizationName: true,
        countryCode: true,
        kycStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const [shipments, comments, notifications, auditLogs] = await Promise.all([
      this.prisma.shipment.findMany({
        where: {
          OR: [
            { buyerAddress: user.stellarAddress },
            { supplierAddress: user.stellarAddress },
            { logisticsAddress: user.stellarAddress },
            { arbiterAddress: user.stellarAddress },
          ],
        },
        select: {
          id: true,
          buyerAddress: true,
          supplierAddress: true,
          logisticsAddress: true,
          arbiterAddress: true,
          tokenAddress: true,
          tokenSymbol: true,
          totalAmount: true,
          releasedAmount: true,
          status: true,
          description: true,
          referenceNumber: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.shipmentComment.findMany({
        where: { authorId: userId },
        select: {
          id: true,
          shipmentId: true,
          body: true,
          visibility: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.findMany({
        where: { userId },
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          data: true,
          read: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.findMany({
        where: { userId },
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      profile: user,
      shipments: shipments.map((s) => ({
        ...s,
        totalAmount: s.totalAmount?.toString(),
        releasedAmount: s.releasedAmount?.toString(),
      })),
      comments,
      notifications,
      auditLogs,
    };
  }

  async getPublicProfile(stellarAddress: string) {
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress },
      select: {
        stellarAddress: true,
        name: true,
        role: true,
        organizationName: true,
        countryCode: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    return {
      ...user,
      avatarUrl: user.avatarCid ? `/api/v1/ipfs/${user.avatarCid}` : null,
    };
  }

  /**
   * Uploads an avatar image to IPFS and attaches the CID to the user profile.
   * Enforces 2 MB limit and allowed image MIME types (png, jpeg, webp).
   */
  async uploadAvatar(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{
    message: string;
    avatarCid: string;
    avatarUrl: string;
  }> {
    if (!file) {
      throw new BadRequestException("Avatar image file is required");
    }

    const allowedMimeTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid file type: ${file.mimetype}. Allowed types: ${allowedMimeTypes.join(", ")}`,
      );
    }

    const maxSizeBytes = 2 * 1024 * 1024; // 2 MB
    const fileSize = file.size ?? file.buffer?.length ?? 0;
    if (fileSize > maxSizeBytes) {
      throw new PayloadTooLargeException("Avatar image must not exceed 2 MB");
    }

    if (!this.ipfs) {
      throw new BadRequestException("IPFS service is not available");
    }

    const cid = await this.ipfs.uploadFile(
      file.buffer,
      file.originalname || "avatar",
      file.mimetype,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarCid: cid },
    });

    const avatarUrl = `/api/v1/ipfs/${cid}`;

    return {
      message: "Avatar uploaded successfully",
      avatarCid: cid,
      avatarUrl,
    };
  }

  /**
   * Clears the avatar CID for the user.
   */
  async deleteAvatar(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, avatarCid: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarCid: null },
    });

    return { message: "Avatar deleted successfully" };
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
    targetUser: {
      id: string;
      stellarAddress: string;
      role: UserRole;
      name: string | null;
    };
  }> {
    if (targetUserId === adminId) {
      throw new BadRequestException("Cannot impersonate your own account");
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
      throw new NotFoundException("User not found");
    }

    if (target.deactivatedAt) {
      throw new ForbiddenException("Cannot impersonate a deactivated user");
    }

    if (target.role === UserRole.ADMIN) {
      throw new ForbiddenException("Cannot impersonate another admin");
    }

    const expiresIn = this.config.get<string>(
      "IMPERSONATION_JWT_EXPIRES_IN",
      "15m",
    );

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
      action: "admin.impersonate",
      resourceType: "User",
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

  /**
   * Force logout a user by immediately revoking all their active JWT sessions
   * and optionally revoking all their active API keys.
   *
   * Admin-only tool for security incident response (e.g. account takeover).
   */
  async forceLogoutUser(
    targetUserId: string,
    adminId: string,
    adminAddress: string,
    dto?: ForceLogoutDto,
    ipAddress?: string,
  ): Promise<{
    message: string;
    revokedSessionsCount: number;
    revokedApiKeysCount: number;
  }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        stellarAddress: true,
      },
    });

    if (!target) {
      throw new NotFoundException("User not found");
    }

    const revokeApiKeys = dto?.revokeApiKeys ?? false;

    // 1. Revoke all active sessions via SessionService
    // includeCurrent: true ensures every active session for the target user is blocklisted
    const revokedSessionsCount = await this.sessions.revokeAllSessions(
      target.id,
      "",
      true,
    );

    // 2. Optionally revoke all active API keys
    let revokedApiKeysCount = 0;
    if (revokeApiKeys) {
      const result = await this.prisma.apiKey.updateMany({
        where: {
          userId: target.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          gracePeriodEndsAt: null,
        },
      });
      revokedApiKeysCount = result.count;
    }

    // 3. Record an audit log entry with the admin as actor
    await this.auditLog.record({
      actorId: adminId,
      actorAddress: adminAddress,
      action: "ADMIN_FORCE_LOGOUT",
      resourceType: "User",
      resourceId: target.id,
      metadata: {
        targetUserId: target.id,
        targetStellarAddress: target.stellarAddress,
        revokedSessionsCount,
        revokedApiKeysCount,
        revokeApiKeys,
      },
      ipAddress,
    });

    this.logger.warn(
      `Admin ${adminId} (${adminAddress}) force-logged out user ${target.id} (${target.stellarAddress}). ` +
        `Revoked ${revokedSessionsCount} session(s) and ${revokedApiKeysCount} API key(s).`,
    );

    return {
      message: "User force-logged out successfully",
      revokedSessionsCount,
      revokedApiKeysCount,
    };
  }

  /**
   * Returns the stored displayCurrency preference for a user.
   * Falls back to 'USD' for unknown users or DB errors — never throws.
   */
  async getUserDisplayCurrency(userId: string): Promise<string> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { displayCurrency: true },
      });
      return user?.displayCurrency ?? "USD";
    } catch {
      return "USD";
    }
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    const updateData: any = {};

    if (dto.name !== undefined) {
      updateData.name = dto.name;
    }

    if (dto.displayCurrency !== undefined) {
      updateData.displayCurrency = dto.displayCurrency.toUpperCase();
    }

    if (dto.locale !== undefined) {
      updateData.locale = dto.locale.toLowerCase();
    }

    if (dto.email !== undefined && dto.email !== user.email) {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });

      if (existing && existing.id !== userId) {
        throw new ConflictException("Email is already in use");
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

  async updateUserRole(
    id: string,
    callerId: string,
    callerAddress: string,
    newRole: UserRole,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (id === callerId && newRole !== UserRole.ADMIN) {
      throw new ConflictException("Admins cannot demote themselves");
    }

    const oldRole = user.role;

    await this.prisma.user.update({ where: { id }, data: { role: newRole } });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: "USER_ROLE_CHANGED",
      resourceType: "User",
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
    orderBy?: "createdAt" | "name";
  }) {
    const {
      role,
      emailVerified,
      page = 1,
      limit = 20,
      orderBy = "createdAt",
    } = filters;

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
        orderBy: orderBy === "name" ? { name: "asc" } : { createdAt: "desc" },
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
      throw new UnauthorizedException("Invalid or expired verification token");
    }

    const storedToken = await this.redis.get(
      this.getVerificationTokenKey(payload.sub),
    );
    if (!storedToken || storedToken !== token) {
      throw new UnauthorizedException("Invalid or expired verification token");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (user.pendingEmail !== payload.email) {
      throw new UnauthorizedException(
        "Verification token does not match pending email",
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: payload.email },
    });

    if (existing && existing.id !== user.id) {
      throw new ConflictException("Email is already in use");
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

    return { message: "Email verified successfully" };
  }

  async resendVerificationEmail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, pendingEmail: true },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (!user.pendingEmail) {
      throw new BadRequestException("No pending email to verify");
    }

    return this.sendVerificationEmail(user.id, user.pendingEmail);
  }

  private getVerificationTokenKey(userId: string) {
    return `${this.EMAIL_VERIFICATION_TOKEN_PREFIX}${userId}`;
  }

  private async sendVerificationEmail(userId: string, email: string) {
    const token = this.jwt.sign({ sub: userId, email }, { expiresIn: "24h" });

    await this.redis.setPx(
      this.getVerificationTokenKey(userId),
      token,
      24 * 60 * 60 * 1000,
    );

    const verificationLink = `${this.config.get("API_BASE_URL", "http://localhost:3000")}/api/v1/auth/verify-email?token=${token}`;

    await this.notifications.sendEmail(
      email,
      "Verify your email address",
      `Click this link to verify your email: ${verificationLink}`,
    );

    return { message: "Verification email sent" };
  }

  // ----------------------------------------------------------
  // Phone verification
  // ----------------------------------------------------------

  /**
   * Initiate phone number verification by sending an OTP.
   * Stores the pending phone and OTP in Redis.
   */
  async sendPhoneVerificationOtp(
    userId: string,
    phoneNumber: string,
  ): Promise<{ message: string }> {
    // Check if phone is already verified
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, phoneVerified: true },
    });

    if (
      existingUser?.phoneVerified &&
      existingUser?.phoneNumber === phoneNumber
    ) {
      throw new BadRequestException("Phone number is already verified");
    }

    // Generate OTP
    const otp = this.generateOtp();
    const key = `${this.PHONE_OTP_PREFIX}${userId}`;

    // Store OTP in Redis with 5-minute TTL
    await this.redis.setPx(key, otp, this.PHONE_OTP_TTL_MS);

    // Store pending phone number (overwrites any previous pending)
    const pendingKey = `${this.PHONE_OTP_PREFIX}${userId}:pending`;
    await this.redis.setPx(pendingKey, phoneNumber, this.PHONE_OTP_TTL_MS);

    // TODO: Actually send SMS via SMS provider when implemented
    // For now, log the OTP for development
    this.logger.log(`Phone verification OTP for ${userId}: ${otp}`);

    return { message: "Verification code sent to your phone" };
  }

  /**
   * Verify phone number with OTP.
   * If OTP is valid, updates user's phoneNumber and sets phoneVerified to true.
   */
  async verifyPhone(
    userId: string,
    otp: string,
  ): Promise<{ message: string; phoneNumber: string }> {
    const key = `${this.PHONE_OTP_PREFIX}${userId}`;
    const pendingKey = `${this.PHONE_OTP_PREFIX}${userId}:pending`;

    const storedOtp = await this.redis.get(key);
    const pendingPhone = await this.redis.get(pendingKey);

    if (!storedOtp || storedOtp !== otp) {
      throw new UnauthorizedException("Invalid or expired verification code");
    }

    if (!pendingPhone) {
      throw new BadRequestException(
        "No pending phone verification. Request a new code.",
      );
    }

    // Clear the OTP and pending phone
    await this.redis.del(key);
    await this.redis.del(pendingKey);

    // Update user's phone
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber: pendingPhone,
        phoneVerified: true,
        pendingPhone: null,
      },
    });

    this.logger.log(`Phone verified for user ${userId}: ${pendingPhone}`);

    return {
      message: "Phone number verified successfully",
      phoneNumber: pendingPhone,
    };
  }

  /**
   * Returns recent login attempts (both successful and failed) for the user,
   * with masked IPv4 addresses and cursor pagination.
   */
  async getLoginHistory(
    userId: string,
    currentJti?: string,
    cursor?: string,
    limit = 20,
  ): Promise<{
    data: Array<{
      id: string;
      timestamp: Date;
      ipAddress: string | null;
      userAgent: string;
      success: boolean;
      isCurrentSession: boolean;
    }>;
    meta: {
      nextCursor: string | null;
      limit: number;
    };
  }> {
    const take = Math.min(Math.max(1, limit || 20), 100);
    const where: any = {
      userId,
      action: { in: ["LOGIN_SUCCESS", "LOGIN_FAILED"] },
    };

    let logs: any[];
    if (cursor) {
      let cursorId = cursor;
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, "base64").toString("utf-8"),
        );
        if (decoded?.id) {
          cursorId = decoded.id;
        }
      } catch {
        // use raw cursor string as id
      }

      logs = await this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        cursor: { id: cursorId },
        skip: 1,
        take,
      });
    } else {
      logs = await this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
      });
    }

    const nextCursor =
      logs.length === take
        ? Buffer.from(
            JSON.stringify({
              id: logs[logs.length - 1].id,
              createdAt: logs[logs.length - 1].createdAt.toISOString(),
            }),
          ).toString("base64")
        : null;

    const data = logs.map((log) => {
      const metadata = (log.metadata as Record<string, any>) ?? {};
      const isSuccess = log.action === "LOGIN_SUCCESS";
      const isCurrentSession =
        isSuccess && Boolean(currentJti && metadata.sessionId === currentJti);

      return {
        id: log.id,
        timestamp: log.createdAt,
        ipAddress: maskIpAddress(log.ipAddress),
        userAgent: metadata.userAgent ?? "unknown",
        success: isSuccess,
        isCurrentSession,
      };
    });

    return {
      data,
      meta: {
        nextCursor,
        limit: take,
      },
    };
  }

  /**
   * Generate a numeric OTP of configured length.
   */
  private generateOtp(): string {
    let otp = "";
    for (let i = 0; i < this.PHONE_OTP_LENGTH; i++) {
      otp += Math.floor(Math.random() * 10).toString();
    }
    return otp;
  }
}
