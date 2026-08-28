import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Multi-signature approval for high-value shipments.
 *
 * Shipments at or above MULTISIG_VALUE_THRESHOLD_STROOPS may carry a
 * `requiredApprovals` count. Until that many co-approvers have signed off, no
 * milestone on the shipment can be confirmed. Shipments below the threshold,
 * and shipments that simply do not set the field, keep the existing
 * single-approver flow untouched.
 */
@Injectable()
export class ShipmentApprovalsService {
  private readonly logger = new Logger(ShipmentApprovalsService.name);
  private readonly threshold: bigint;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Mirrors the KYC threshold convention: stroops as a string, since the
    // value exceeds what a JS number holds precisely.
    this.threshold = BigInt(
      this.config.get<string>('MULTISIG_VALUE_THRESHOLD_STROOPS', '1000000000000'),
    );
  }

  /** Whether a shipment of this size is eligible for multi-approver sign-off. */
  meetsThreshold(totalAmount: bigint): boolean {
    return totalAmount >= this.threshold;
  }

  /**
   * Validate a requiredApprovals value supplied at shipment creation.
   *
   * Returns the count to persist, or null when the shipment should use the
   * default single-approver flow.
   *
   * Asking for approvals on a shipment below the threshold is rejected rather
   * than silently ignored, so a caller who believes they have gated a shipment
   * is never quietly wrong about it.
   */
  resolveRequiredApprovals(
    requiredApprovals: number | undefined,
    totalAmount: bigint,
  ): number | null {
    if (requiredApprovals === undefined || requiredApprovals === null) {
      return null;
    }

    if (!this.meetsThreshold(totalAmount)) {
      throw new BadRequestException(
        'requiredApprovals is only accepted for shipments at or above the ' +
          'multi-signature value threshold. Omit it for smaller shipments, ' +
          'which use the single-approver flow.',
      );
    }

    if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1) {
      throw new BadRequestException('requiredApprovals must be a positive integer');
    }

    return requiredApprovals;
  }

  /**
   * Record a co-approver's sign-off.
   *
   * Only the shipment's own participants may approve, and each address counts
   * once: a repeated call is a conflict rather than a second approval, so a
   * quorum cannot be reached by one party calling the endpoint N times.
   */
  async approve(shipmentId: string, approverAddress: string, note?: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        requiredApprovals: true,
        buyerAddress: true,
        supplierAddress: true,
        logisticsAddress: true,
        arbiterAddress: true,
      },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    const participants = [
      shipment.buyerAddress,
      shipment.supplierAddress,
      shipment.logisticsAddress,
      shipment.arbiterAddress,
    ];

    if (!participants.includes(approverAddress)) {
      throw new ForbiddenException(
        'Only a participant on this shipment may record an approval',
      );
    }

    if (shipment.requiredApprovals === null) {
      throw new BadRequestException(
        `Shipment ${shipmentId} does not require multi-signature approval`,
      );
    }

    const existing = await this.prisma.shipmentApproval.findFirst({
      where: { shipmentId, approverAddress },
    });

    if (existing) {
      throw new ConflictException(
        'This address has already approved this shipment',
      );
    }

    const approval = await this.prisma.shipmentApproval.create({
      data: { shipmentId, approverAddress, note },
    });

    const approvalCount = await this.prisma.shipmentApproval.count({
      where: { shipmentId },
    });

    this.logger.log(
      `Approval recorded for shipment ${shipmentId} by ${approverAddress} ` +
        `(${approvalCount}/${shipment.requiredApprovals})`,
    );

    return {
      approval,
      approvalCount,
      requiredApprovals: shipment.requiredApprovals,
      quorumMet: approvalCount >= shipment.requiredApprovals,
    };
  }

  /** Every approval recorded against a shipment, oldest first. */
  async listApprovals(shipmentId: string) {
    return this.prisma.shipmentApproval.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Approval progress for a shipment, for the detail response.
   *
   * `required` is null and `quorumMet` true for a shipment on the default
   * single-approver flow, so callers can treat quorumMet uniformly.
   */
  async getApprovalStatus(shipmentId: string, requiredApprovals: number | null) {
    if (requiredApprovals === null) {
      return { required: null, count: 0, quorumMet: true, approvals: [] };
    }

    const approvals = await this.listApprovals(shipmentId);
    return {
      required: requiredApprovals,
      count: approvals.length,
      quorumMet: approvals.length >= requiredApprovals,
      approvals,
    };
  }

  /** Whether a shipment has gathered enough approvals to proceed. */
  async hasQuorum(shipmentId: string): Promise<boolean> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { requiredApprovals: true },
    });

    if (!shipment || shipment.requiredApprovals === null) return true;

    const count = await this.prisma.shipmentApproval.count({
      where: { shipmentId },
    });
    return count >= shipment.requiredApprovals;
  }

  /**
   * Gate used by milestone confirmation. Throws when the shipment still needs
   * approvals; returns silently for shipments on the single-approver flow.
   */
  async assertQuorum(shipmentId: string): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { requiredApprovals: true },
    });

    if (!shipment || shipment.requiredApprovals === null) return;

    const count = await this.prisma.shipmentApproval.count({
      where: { shipmentId },
    });

    if (count < shipment.requiredApprovals) {
      throw new ForbiddenException(
        `Shipment ${shipmentId} requires ${shipment.requiredApprovals} approvals ` +
          `before a milestone can be confirmed. ${count} recorded so far.`,
      );
    }
  }
}
