import {
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DAILY_INVITATION_LIMIT = 20;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async create(inviter: { id: string; stellarAddress: string }, dto: CreateInvitationDto) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sentToday = await this.prisma.shipmentInvitation.count({
      where: { invitedById: inviter.id, createdAt: { gte: since } },
    });
    if (sentToday >= DAILY_INVITATION_LIMIT) {
      throw new HttpException(
        `Invitation limit of ${DAILY_INVITATION_LIMIT} per day reached`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (dto.shipmentId) {
      const shipment = await this.prisma.shipment.findUnique({ where: { id: dto.shipmentId } });
      if (!shipment) throw new NotFoundException(`Shipment ${dto.shipmentId} not found`);
    }

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.shipmentInvitation.create({
      data: {
        email: dto.email.toLowerCase(),
        role: dto.role,
        shipmentId: dto.shipmentId,
        templateId: dto.templateId,
        tokenHash: hashToken(token),
        invitedById: inviter.id,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });

    const baseUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const link = `${baseUrl}/invitations/accept?token=${encodeURIComponent(token)}`;
    await this.notifications.sendEmail(
      invitation.email,
      "You've been invited to ChainSettle",
      `${inviter.stellarAddress} invited you to join ChainSettle as ${dto.role}.\n` +
        `Accept within 7 days: ${link}`,
      `<p><code>${inviter.stellarAddress}</code> invited you to join ChainSettle as <b>${dto.role}</b>.</p>` +
        `<p><a href="${link}">Accept invitation</a> (expires in 7 days)</p>`,
    );

    return this.toResponse(invitation);
  }

  async accept(token: string, user: { id: string; stellarAddress: string }) {
    const invitation = await this.prisma.shipmentInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { invitedBy: { select: { stellarAddress: true } } },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.acceptedAt) throw new GoneException('Invitation has already been used');
    if (invitation.expiresAt <= new Date()) throw new GoneException('Invitation has expired');

    // Conditional update makes the token single-use under concurrent accepts.
    const { count } = await this.prisma.shipmentInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null },
      data: { acceptedAt: new Date(), acceptedById: user.id },
    });
    if (count === 0) throw new GoneException('Invitation has already been used');

    await this.notifications.notifyUser(
      invitation.invitedBy.stellarAddress,
      NotificationType.SYSTEM_ALERT,
      'Invitation accepted',
      `${invitation.email} accepted your invitation as ${invitation.role} (${user.stellarAddress}).`,
      {
        invitationId: invitation.id,
        shipmentId: invitation.shipmentId,
        stellarAddress: user.stellarAddress,
      },
    );

    const updated = await this.prisma.shipmentInvitation.findUnique({ where: { id: invitation.id } });
    return this.toResponse(updated!);
  }

  async listSent(inviterId: string) {
    const rows = await this.prisma.shipmentInvitation.findMany({
      where: { invitedById: inviterId },
      orderBy: { createdAt: 'desc' },
      include: { acceptedBy: { select: { stellarAddress: true } } },
    });
    return rows.map((r) => ({
      ...this.toResponse(r),
      acceptedByAddress: r.acceptedBy?.stellarAddress ?? null,
    }));
  }

  private toResponse(inv: {
    id: string;
    email: string;
    role: string;
    shipmentId: string | null;
    templateId: string | null;
    acceptedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
  }) {
    const status = inv.acceptedAt ? 'ACCEPTED' : inv.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING';
    const { id, email, role, shipmentId, templateId, acceptedAt, expiresAt, createdAt } = inv;
    return { id, email, role, shipmentId, templateId, status, acceptedAt, expiresAt, createdAt };
  }
}
