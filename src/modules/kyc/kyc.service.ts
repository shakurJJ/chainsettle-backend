import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import { KycStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { KycWebhookDto } from './dto/kyc-webhook.dto';

export type KycTier = 'none' | 'basic' | 'enhanced';

export interface KycRequirements {
  tier: KycTier;
  documents: string[];
}

const BASIC_TIER_DOCUMENTS = ['government_id', 'proof_of_address'];
const ENHANCED_TIER_DOCUMENTS = [...BASIC_TIER_DOCUMENTS, 'proof_of_funds', 'enhanced_due_diligence'];

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  /** Source of truth for both `meetsThreshold()` and `getRequirements()` — see #285. */
  private readonly threshold: bigint;
  private readonly enhancedThreshold: bigint;
  private readonly webhookSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
  ) {
    this.threshold = BigInt(this.config.get<string>('KYC_VALUE_THRESHOLD_STROOPS', '1000000000000'));
    this.enhancedThreshold = BigInt(
      this.config.get<string>('KYC_ENHANCED_VALUE_THRESHOLD_STROOPS', '10000000000000'),
    );
    this.webhookSecret = this.config.get<string>('KYC_WEBHOOK_SECRET', '');
  }

  /** Whether a shipment of this size requires both parties to be KYC-verified. */
  meetsThreshold(totalAmount: bigint): boolean {
    return this.getRequirements(totalAmount).tier !== 'none';
  }

  /**
   * The KYC tier/documents required for a shipment of a given value, using
   * the same thresholds `meetsThreshold()` gates shipment creation with.
   */
  getRequirements(value: bigint): KycRequirements {
    if (value >= this.enhancedThreshold) {
      return { tier: 'enhanced', documents: ENHANCED_TIER_DOCUMENTS };
    }
    if (value >= this.threshold) {
      return { tier: 'basic', documents: BASIC_TIER_DOCUMENTS };
    }
    return { tier: 'none', documents: [] };
  }

  async isVerified(stellarAddress: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress },
      select: { kycStatus: true },
    });
    return user?.kycStatus === KycStatus.VERIFIED;
  }

  /**
   * Begins verification for the authenticated user: marks them PENDING and
   * issues an opaque reference the provider will echo back on its webhook.
   * Only the reference is stored — never any identity document data.
   */
  async initiateVerification(userId: string): Promise<{ reference: string; kycStatus: KycStatus }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const reference = randomUUID();

    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: KycStatus.PENDING, kycReference: reference },
    });

    await this.auditLog.record({
      actorId: userId,
      actorAddress: user.stellarAddress,
      action: 'KYC_VERIFICATION_INITIATED',
      resourceType: 'User',
      resourceId: userId,
      metadata: { reference },
    });

    this.logger.log(`KYC verification initiated for user ${userId} — reference ${reference}`);
    return { reference, kycStatus: KycStatus.PENDING };
  }

  async getStatus(userId: string): Promise<{ kycStatus: KycStatus; kycReference: string | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true, kycReference: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Verifies the provider's HMAC signature (when KYC_WEBHOOK_SECRET is
   * configured) and applies the verification result to the matching user.
   */
  async handleWebhook(dto: KycWebhookDto, signature?: string): Promise<{ message: string }> {
    if (this.webhookSecret) {
      const expected = createHmac('sha256', this.webhookSecret)
        .update(JSON.stringify(dto))
        .digest('hex');
      if (!signature || signature !== expected) {
        throw new UnauthorizedException('Invalid KYC webhook signature');
      }
    } else {
      this.logger.warn('KYC_WEBHOOK_SECRET is not configured — accepting webhook without signature verification');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ kycReference: dto.reference }, { stellarAddress: dto.stellarAddress }],
      },
    });

    if (!user) {
      throw new NotFoundException(`No user found for reference "${dto.reference}" / address "${dto.stellarAddress}"`);
    }

    const kycStatus = KycStatus[dto.status];

    await this.prisma.user.update({
      where: { id: user.id },
      data: { kycStatus, kycReference: dto.reference },
    });

    await this.auditLog.record({
      actorAddress: dto.stellarAddress,
      action: 'KYC_STATUS_UPDATED',
      resourceType: 'User',
      resourceId: user.id,
      metadata: { reference: dto.reference, kycStatus },
    });

    this.logger.log(`KYC status for user ${user.id} updated to ${kycStatus} (reference ${dto.reference})`);
    return { message: 'KYC status updated' };
  }

  /**
   * Withdraws a still-pending KYC submission, identified by the opaque
   * `reference` handed back from `initiateVerification()`. Only the owning
   * user may withdraw it, and only while it hasn't been decided yet. See #286.
   */
  async withdraw(userId: string, id: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (!user.kycReference || user.kycReference !== id) {
      throw new NotFoundException(`No KYC submission found with id "${id}"`);
    }

    if (user.kycStatus === KycStatus.VERIFIED || user.kycStatus === KycStatus.REJECTED) {
      throw new ConflictException('This KYC submission has already been decided and can no longer be withdrawn');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: KycStatus.UNVERIFIED, kycReference: null },
    });

    await this.auditLog.record({
      actorId: userId,
      actorAddress: user.stellarAddress,
      action: 'KYC_VERIFICATION_WITHDRAWN',
      resourceType: 'User',
      resourceId: userId,
      metadata: { reference: id },
    });

    this.logger.log(`KYC verification withdrawn for user ${userId} — reference ${id}`);
    return { message: 'KYC submission withdrawn' };
  }
}
