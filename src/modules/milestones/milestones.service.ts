import { 
  Injectable, 
  NotFoundException, 
  Logger, 
  ForbiddenException, 
  ConflictException,
  BadRequestException
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IpfsService } from '../../common/ipfs/ipfs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { MilestoneStatus, NotificationType, DisputeRole, ArbiterStatus } from '@prisma/client';

@Injectable()
export class MilestonesService {
  private readonly logger = new Logger(MilestonesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ipfs: IpfsService,
    private readonly notifications: NotificationsService,
    private readonly shipments: ShipmentsService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findByShipment(shipmentId: string, status?: string, overdueOnly = false) {
    const where: any = { shipmentId };

    if (status) {
      where.status = status;
    }

    if (overdueOnly) {
      where.dueAt = { lt: new Date() };
      where.status = { notIn: [MilestoneStatus.CONFIRMED, MilestoneStatus.RESOLVED] };
    }

    const milestones = await this.prisma.milestone.findMany({
      where,
      orderBy: { milestoneIndex: 'asc' },
    });

    return milestones.map((m) => ({
      ...m,
      isOverdue: m.dueAt ? m.dueAt < new Date() && m.status !== MilestoneStatus.CONFIRMED && m.status !== MilestoneStatus.RESOLVED : false,
    }));
  }

  async findOne(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
    });
    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`,
      );
    }
    return milestone;
  }

  // ----------------------------------------------------------
  // PROOF SUBMISSION
  // ----------------------------------------------------------

  /**
   * Uploads a proof file to IPFS and persists the resulting CID.
   * Restricted to the shipment's supplierAddress or logisticsAddress.
   *
   * @param shipmentId     - Shipment identifier
   * @param milestoneIndex - 0-based milestone index
   * @param callerAddress  - Stellar address of the authenticated caller
   * @param file           - Uploaded file (from multer)
   * @returns The updated milestone record and the IPFS gateway URL
   */
  async submitProof(
    shipmentId: string,
    milestoneIndex: number,
    callerAddress: string,
    file: Express.Multer.File,
  ) {
    // Fetch the shipment to verify caller is authorized
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.status === 'CANCELLED') {
      throw new ConflictException(`Cannot submit proof: shipment ${shipmentId} is CANCELLED`);
    }

    const isAuthorized =
      shipment.supplierAddress === callerAddress ||
      shipment.logisticsAddress === callerAddress;

    if (!isAuthorized) {
      throw new ForbiddenException(
        'Only the shipment supplier or logistics provider may submit proof',
      );
    }

    // Ensure the milestone exists before uploading
    const milestone = await this.findOne(shipmentId, milestoneIndex);

    // Upload to IPFS
    const cid = await this.ipfs.uploadFile(
      file.buffer,
      file.originalname,
      file.mimetype,
    );

    // Persist CID + status transition
    const updated = await this.markProofSubmitted(shipmentId, milestoneIndex, cid);

    // Record proof submission in audit trail (immutable history)
    await this.prisma.proofSubmission.create({
      data: {
        milestoneId: milestone.id,
        ipfsCid: cid,
        submittedBy: callerAddress,
      },
    });

    this.logger.log(
      `Proof submitted for ${shipmentId}[${milestoneIndex}] — CID: ${cid}`,
    );

    // Notify buyer
    await this.notifications.notifyUser(
      shipment.buyerAddress,
      NotificationType.PROOF_SUBMITTED,
      'Proof submitted for review',
      `Milestone ${milestoneIndex} ("${milestone.name}") proof has been uploaded for shipment ${shipmentId}. Please review and confirm.`,
      { shipmentId, milestoneIndex, proofHash: cid },
    );

    return {
      milestone: updated,
      cid,
      gatewayUrl: this.ipfs.getGatewayUrl(cid),
    };
  }

  /**
   * Buyer registers a milestone confirmation transaction hash after signing
   * it in Freighter. Mirrors the on-chain `handleMilestoneConfirmed` event
   * handler so the DB reflects the confirmation immediately.
   *
   * Restricted to the shipment's buyerAddress.
   */
  async confirmFromApi(
    shipmentId: string,
    milestoneIndex: number,
    callerAddress: string,
    txHash: string,
    paymentReleased: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer may confirm milestones');
    }

    const milestone = await this.findOne(shipmentId, milestoneIndex);

    if (milestone.status !== MilestoneStatus.PROOF_SUBMITTED) {
      throw new ConflictException(
        `Milestone ${milestoneIndex} must be in PROOF_SUBMITTED status to confirm (currently ${milestone.status})`,
      );
    }

    const updated = await this.markConfirmed(shipmentId, milestoneIndex, BigInt(paymentReleased));

    await this.shipments.syncStatusFromChain(shipmentId);

    await this.notifications.notifyUser(
      shipment.supplierAddress,
      NotificationType.PAYMENT_RELEASED,
      'Payment released',
      `Payment has been released for milestone ${milestoneIndex} on shipment ${shipmentId}. Tx: ${txHash}`,
      { shipmentId, milestoneIndex, paymentReleased, txHash },
    );

    return updated;
  }

  // ----------------------------------------------------------
  // INTERNAL HELPERS (called by EventsService)
  // ----------------------------------------------------------

  /**
   * Called by EventsService when a proof_submitted event is detected on-chain.
   * Updates the local DB record to reflect the new proof hash and status.
   */
  async markProofSubmitted(
    shipmentId: string,
    milestoneIndex: number,
    proofHash: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (shipment?.status === 'CANCELLED') {
      throw new ConflictException(`Cannot submit proof for a cancelled shipment`);
    }

    return this.prisma.milestone.update({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      data: {
        proofHash,
        status: MilestoneStatus.PROOF_SUBMITTED,
      },
    });
  }

  /**
   * Called by EventsService when a milestone_confirmed event is detected.
   */
  async markConfirmed(
    shipmentId: string,
    milestoneIndex: number,
    paymentReleased: bigint,
  ) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (shipment?.status === 'CANCELLED') {
      throw new ConflictException(`Cannot confirm a milestone for a cancelled shipment`);
    }

    return this.prisma.milestone.update({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      data: {
        status: MilestoneStatus.CONFIRMED,
        paymentReleased,
        confirmedAt: new Date(),
      },
    });
  }

  /**
   * Called by EventsService when a dispute_raised event is detected.
   */
  async markDisputed(shipmentId: string, milestoneIndex: number) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (shipment?.status === 'CANCELLED') {
      throw new ConflictException(`Cannot raise a dispute for a cancelled shipment`);
    }

    return this.prisma.milestone.update({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      data: { status: MilestoneStatus.DISPUTED },
    });
  }

  /**
   * Called by EventsService when a dispute_resolved event is detected.
   */
  async markResolved(
    shipmentId: string,
    milestoneIndex: number,
    approved: boolean,
    paymentReleased?: bigint,
  ) {
    return this.prisma.milestone.update({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      data: {
        status: approved ? MilestoneStatus.RESOLVED : MilestoneStatus.PENDING,
        ...(approved && paymentReleased
          ? { paymentReleased, confirmedAt: new Date() }
          : {}),
      },
    });
  }

  async getDisputeDetail(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
    });

    if (!milestone) {
      throw new NotFoundException(`Milestone ${milestoneIndex} not found on shipment ${shipmentId}`);
    }

    if (milestone.status !== MilestoneStatus.DISPUTED) {
      throw new ConflictException(`Milestone ${milestoneIndex} is not currently disputed`);
    }

    const evidence = await this.prisma.disputeEvidence.findMany({
      where: { milestoneId: milestone.id },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            stellarAddress: true,
            name: true,
          },
        },
      },
    });

    return {
      shipmentId,
      milestoneIndex,
      status: milestone.status,
      disputeEscalatedAt: milestone.disputeEscalatedAt,
      resolvedAt: String(milestone.status) === String(MilestoneStatus.RESOLVED) ? milestone.updatedAt : undefined,
      evidence: evidence.map((item) => ({
        ...item,
        ipfsUrl: item.ipfsCid ? this.ipfs.getGatewayUrl(item.ipfsCid) : null,
      })),
    };
  }

  /**
   * Submit dispute evidence for a milestone
   * Only buyer or supplier can submit when milestone is DISPUTED
   */
  async submitDisputeEvidence(
    shipmentId: string,
    milestoneIndex: number,
    submittedBy: string,
    description: string,
    file?: Express.Multer.File,
  ) {
    // Get milestone and shipment
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      include: { shipment: true },
    });

    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`
      );
    }

    if (milestone.shipment.status === 'CANCELLED') {
      throw new ConflictException(`Cannot submit dispute evidence: shipment ${shipmentId} is CANCELLED`);
    }

    // Check milestone status
    if (milestone.status !== MilestoneStatus.DISPUTED) {
      throw new ConflictException(
        `Cannot submit evidence: milestone status is ${milestone.status}, must be DISPUTED`
      );
    }

    // Determine role and check authorization
    let role: DisputeRole;
    if (submittedBy === milestone.shipment.buyerAddress) {
      role = DisputeRole.BUYER;
    } else if (submittedBy === milestone.shipment.supplierAddress) {
      role = DisputeRole.SUPPLIER;
    } else {
      throw new ForbiddenException(
        'Only the buyer or supplier can submit dispute evidence'
      );
    }

    // Upload file to IPFS if provided
    let ipfsCid: string | null = null;
    let fileName: string | null = null;
    let fileSize: number | null = null;
    let mimeType: string | null = null;

    if (file) {
      try {
        ipfsCid = await this.ipfs.uploadFile(file.buffer, file.originalname, file.mimetype);
        fileName = file.originalname;
        fileSize = file.size;
        mimeType = file.mimetype;
        this.logger.log(
          `Evidence file uploaded to IPFS: ${fileName} -> ${ipfsCid}`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error('Failed to upload evidence to IPFS', errorMessage);
        throw new Error('Failed to upload file to IPFS');
      }
    }

    // Create evidence record
    const evidence = await this.prisma.disputeEvidence.create({
      data: {
        milestoneId: milestone.id,
        submittedBy,
        role,
        description,
        ipfsCid,
        fileName,
        fileSize,
        mimeType,
      },
    });

    // Only notify the arbiter if they have accepted their assignment
    if (milestone.shipment.arbiterStatus === ArbiterStatus.ACCEPTED) {
      await this.notifications.notifyUser(
        milestone.shipment.arbiterAddress,
        NotificationType.DISPUTE_EVIDENCE_SUBMITTED,
        'New Dispute Evidence Submitted',
        `${role} has submitted evidence for milestone ${milestoneIndex} on shipment ${shipmentId}`,
        {
          shipmentId,
          milestoneIndex,
          evidenceId: evidence.id,
          submittedBy,
          role,
        }
      );
    } else {
      this.logger.warn(
        `Arbiter ${milestone.shipment.arbiterAddress} has not accepted assignment for shipment ${shipmentId} — skipping notification`,
      );
    }

    this.logger.log(
      `Dispute evidence submitted: ${evidence.id} by ${role} for milestone ${milestoneIndex}`
    );

    return evidence;
  }

  /**
   * Get all dispute evidence for a milestone
   * Restricted to shipment participants and admins
   */
  async getDisputeEvidence(
    shipmentId: string,
    milestoneIndex: number,
    requestedBy: string,
  ) {
    // Get milestone and shipment
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      include: { shipment: true },
    });

    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`
      );
    }

    // Check authorization - must be a participant
    const isParticipant = [
      milestone.shipment.buyerAddress,
      milestone.shipment.supplierAddress,
      milestone.shipment.logisticsAddress,
      milestone.shipment.arbiterAddress,
    ].includes(requestedBy);

    // Check if user is admin
    const user = await this.prisma.user.findUnique({
      where: { stellarAddress: requestedBy },
    });

    const isAdmin = user?.role === 'ADMIN';

    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException(
        'Only shipment participants can view dispute evidence'
      );
    }

    // Get all evidence for this milestone
    const evidence = await this.prisma.disputeEvidence.findMany({
      where: { milestoneId: milestone.id },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            stellarAddress: true,
            name: true,
          },
        },
      },
    });

    // Add IPFS gateway URLs
    return evidence.map((item) => ({
      ...item,
      ipfsUrl: item.ipfsCid ? this.ipfs.getGatewayUrl(item.ipfsCid) : null,
    }));
  }

  /**
   * Fetch a single dispute evidence record by ID.
   * Verifies the evidence belongs to the correct milestone.
   * Accessible by shipment participants or admins.
   */
  async getOneEvidence(
    shipmentId: string,
    milestoneIndex: number,
    evidenceId: string,
    requestedBy: string,
    isAdmin: boolean,
  ) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      include: { shipment: true },
    });

    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`,
      );
    }

    if (!isAdmin) {
      const isParticipant = [
        milestone.shipment.buyerAddress,
        milestone.shipment.supplierAddress,
        milestone.shipment.logisticsAddress,
        milestone.shipment.arbiterAddress,
      ].includes(requestedBy);

      if (!isParticipant) {
        throw new ForbiddenException(
          'Only shipment participants can view dispute evidence',
        );
      }
    }

    const evidence = await this.prisma.disputeEvidence.findFirst({
      where: { id: evidenceId, milestoneId: milestone.id },
      include: {
        user: {
          select: {
            stellarAddress: true,
            name: true,
          },
        },
      },
    });

    if (!evidence) {
      throw new NotFoundException(
        `Evidence ${evidenceId} not found or belongs to a different milestone`,
      );
    }

    return {
      ...evidence,
      ipfsUrl: evidence.ipfsCid ? this.ipfs.getGatewayUrl(evidence.ipfsCid) : null,
    };
  }

  /**
   * Download a dispute evidence file through the backend proxy
   */
  async downloadEvidence(
    shipmentId: string,
    milestoneIndex: number,
    evidenceId: string,
  ): Promise<{ fileBuffer: Buffer; fileName: string; mimeType: string }> {
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
    });

    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`
      );
    }

    const evidence = await this.prisma.disputeEvidence.findUnique({
      where: { id: evidenceId, milestoneId: milestone.id },
    });

    if (!evidence || !evidence.ipfsCid) {
      throw new NotFoundException('Evidence not found or no file attached');
    }

    const { buffer: fileBuffer } = await this.ipfs.getFile(evidence.ipfsCid);

    return {
      fileBuffer,
      fileName: evidence.fileName || 'download',
      mimeType: evidence.mimeType || 'application/octet-stream',
    };
  }

  // ----------------------------------------------------------
  // PROOF REJECTION — buyer sends proof back for resubmission
  // ----------------------------------------------------------

  /**
   * Rejects a submitted proof, reverting the milestone to PENDING.
   * Only the shipment buyer may call this. Milestone must be PROOF_SUBMITTED.
   * The proofHash is cleared (the value lives on in ProofSubmission history).
   * Notifies the supplier with the buyer's reason.
   */
  async rejectProof(
    shipmentId: string,
    milestoneIndex: number,
    buyerAddress: string,
    reason: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.buyerAddress !== buyerAddress) {
      throw new ForbiddenException('Only the shipment buyer may reject a proof');
    }

    const milestone = await this.findOne(shipmentId, milestoneIndex);

    if (milestone.status !== MilestoneStatus.PROOF_SUBMITTED) {
      throw new ConflictException(
        `Milestone ${milestoneIndex} must be in PROOF_SUBMITTED status to reject (currently ${milestone.status})`,
      );
    }

    const updated = await this.prisma.milestone.update({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
      data: {
        status: MilestoneStatus.PENDING,
        proofHash: null,
      },
    });

    this.logger.log(
      `Proof rejected for ${shipmentId}[${milestoneIndex}] by buyer ${buyerAddress}`,
    );

    // Notify supplier with the rejection reason
    await this.notifications.notifyUser(
      shipment.supplierAddress,
      NotificationType.PROOF_REJECTED,
      'Proof rejected — resubmission requested',
      `Your proof for milestone ${milestoneIndex} ("${milestone.name}") on shipment ${shipmentId} was rejected. Reason: ${reason}`,
      { shipmentId, milestoneIndex, reason },
    );

    return updated;
  }

  // ----------------------------------------------------------
  // PROOF HISTORY — immutable audit trail of all proof submissions
  // ----------------------------------------------------------

  /**
   * Returns all ProofSubmission rows for a milestone in chronological order.
   * Pre-migration milestones with no history rows will return an empty array.
   * Access is gated by ShipmentParticipantGuard in the controller.
   */
  async getProofHistory(shipmentId: string, milestoneIndex: number) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
    });

    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`,
      );
    }

    const submissions = await this.prisma.proofSubmission.findMany({
      where: { milestoneId: milestone.id },
      orderBy: { createdAt: 'asc' },
    });

    return submissions.map((s) => ({
      ipfsCid: s.ipfsCid,
      submittedBy: s.submittedBy,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  // ----------------------------------------------------------
  // REMOVE MILESTONE — delete a still-pending milestone
  // ----------------------------------------------------------

  /**
   * Removes a pending milestone from a shipment. Only allowed when ALL
   * milestones on the shipment (including the target) are still PENDING.
   * Restricted to the shipment buyer.
   *
   * The removed milestone's data is preserved in an audit log entry.
   */
  async removeMilestone(
    shipmentId: string,
    milestoneIndex: number,
    callerAddress: string,
    callerId?: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer may remove milestones');
    }

    const milestone = await this.prisma.milestone.findUnique({
      where: { shipmentId_milestoneIndex: { shipmentId, milestoneIndex } },
    });

    if (!milestone) {
      throw new NotFoundException(
        `Milestone ${milestoneIndex} not found on shipment ${shipmentId}`,
      );
    }

    // Reject if the target milestone has left PENDING
    if (milestone.status !== MilestoneStatus.PENDING) {
      throw new ConflictException(
        `Cannot remove milestone ${milestoneIndex} ("${milestone.name}"): ` +
        `status is ${milestone.status}, expected PENDING.`,
      );
    }

    const allMilestones = await this.prisma.milestone.findMany({
      where: { shipmentId },
    });

    // Reject if any OTHER milestone has left PENDING
    const otherNonPending = allMilestones.find(
      (m) => m.milestoneIndex !== milestoneIndex && m.status !== MilestoneStatus.PENDING,
    );
    if (otherNonPending) {
      throw new ConflictException(
        `Cannot remove milestone: milestone ${otherNonPending.milestoneIndex} ("${otherNonPending.name}") ` +
        `is in status ${otherNonPending.status}, expected PENDING. ` +
        `Work has already started on this shipment.`,
      );
    }

    // Reject if this is the only remaining milestone
    if (allMilestones.length <= 1) {
      throw new BadRequestException(
        'Cannot remove the only milestone on a shipment. A shipment must have at least one milestone.',
      );
    }

    // Capture milestone data for audit before deletion
    const milestoneData = {
      id: milestone.id,
      milestoneIndex: milestone.milestoneIndex,
      name: milestone.name,
      paymentPercent: milestone.paymentPercent,
      status: milestone.status,
      dueAt: milestone.dueAt?.toISOString() ?? null,
    };

    await this.prisma.milestone.delete({
      where: { id: milestone.id },
    });

    await this.auditLog.record({
      actorId: callerId,
      actorAddress: callerAddress,
      action: 'milestone.removed',
      resourceType: 'Milestone',
      resourceId: milestone.id,
      metadata: {
        shipmentId,
        removedMilestone: milestoneData,
      },
    });

    this.logger.log(
      `Milestone ${milestoneIndex} ("${milestone.name}") removed from ${shipmentId} by buyer ${callerAddress}`,
    );

    return { removed: true, milestone: milestoneData };
  }

  // ----------------------------------------------------------
  // REBALANCE — atomically redistribute payment percentages
  // ----------------------------------------------------------

  async rebalance(
    shipmentId: string,
    callerAddress: string,
    updates: Array<{ milestoneIndex: number; paymentPercent: number }>,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment) {
      throw new NotFoundException(`Shipment ${shipmentId} not found`);
    }

    if (shipment.buyerAddress !== callerAddress) {
      throw new ForbiddenException('Only the shipment buyer may rebalance milestones');
    }

    const allMilestones = await this.prisma.milestone.findMany({
      where: { shipmentId },
      orderBy: { milestoneIndex: 'asc' },
    });

    const milestoneMap = new Map(allMilestones.map((m) => [m.milestoneIndex, m]));

    for (const update of updates) {
      const milestone = milestoneMap.get(update.milestoneIndex);
      if (!milestone) {
        throw new NotFoundException(
          `Milestone ${update.milestoneIndex} not found on shipment ${shipmentId}`,
        );
      }
      if (milestone.status !== MilestoneStatus.PENDING) {
        throw new ConflictException(
          `Milestone ${update.milestoneIndex} is not PENDING (status: ${milestone.status})`,
        );
      }
    }

    const updateMap = new Map(updates.map((u) => [u.milestoneIndex, u.paymentPercent]));
    const totalPercent = allMilestones.reduce(
      (sum, m) =>
        sum +
        (updateMap.has(m.milestoneIndex)
          ? updateMap.get(m.milestoneIndex)!
          : m.paymentPercent),
      0,
    );

    if (totalPercent !== 100) {
      throw new BadRequestException(
        `Rebalanced percentages must sum to 100. Got ${totalPercent}.`,
      );
    }

    await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.milestone.update({
          where: {
            shipmentId_milestoneIndex: { shipmentId, milestoneIndex: u.milestoneIndex },
          },
          data: { paymentPercent: u.paymentPercent },
        }),
      ),
    );

    this.logger.log(`Milestones rebalanced for ${shipmentId} by buyer ${callerAddress}`);

    return this.prisma.milestone.findMany({
      where: { shipmentId },
      orderBy: { milestoneIndex: 'asc' },
    });
  }
}
