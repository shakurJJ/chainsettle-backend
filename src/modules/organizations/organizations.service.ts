import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Higher number = more privileges. */
const ROLE_RANK: Record<OrganizationRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export interface ShipmentParticipants {
  buyerAddress: string;
  supplierAddress: string;
  logisticsAddress: string;
  arbiterAddress: string;
}

export function participantAddressesOf(s: ShipmentParticipants): string[] {
  return [s.buyerAddress, s.supplierAddress, s.logisticsAddress, s.arbiterAddress];
}

/**
 * Organizations (#435): several users share read visibility over the
 * shipments of every member's Stellar address. Membership never grants
 * on-chain write rights — those still need the participant's own wallet.
 * Access is always resolved from the DB, so removing a member revokes
 * access on the very next request.
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, name: string) {
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException('name is required');
    const org = await this.prisma.organization.create({
      data: {
        name: trimmed,
        createdBy: userId,
        members: { create: { userId, role: OrganizationRole.OWNER } },
      },
      include: { members: true },
    });
    this.logger.log(`Organization ${org.id} created by ${userId}`);
    return org;
  }

  listMine(userId: string) {
    return this.prisma.organizationMember
      .findMany({
        where: { userId },
        include: { organization: true },
        orderBy: { createdAt: 'asc' },
      })
      .then((rows) => rows.map((m) => ({ ...m.organization, role: m.role })));
  }

  async listMembers(orgId: string, callerId: string) {
    await this.requireRole(orgId, callerId, OrganizationRole.VIEWER);
    return this.prisma.organizationMember.findMany({
      where: { orgId },
      include: { user: { select: { id: true, stellarAddress: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(
    orgId: string,
    callerId: string,
    target: { userId?: string; stellarAddress?: string },
    role: OrganizationRole = OrganizationRole.MEMBER,
  ) {
    const callerRole = await this.requireRole(orgId, callerId, OrganizationRole.ADMIN);
    this.assertCanAssign(callerRole, role);

    const user = await this.prisma.user.findFirst({
      where: target.userId ? { id: target.userId } : { stellarAddress: target.stellarAddress },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const existing = await this.getMembership(orgId, user.id);
    if (existing) throw new ConflictException('User is already a member');

    return this.prisma.organizationMember.create({ data: { orgId, userId: user.id, role } });
  }

  async changeRole(orgId: string, callerId: string, userId: string, role: OrganizationRole) {
    const callerRole = await this.requireRole(orgId, callerId, OrganizationRole.ADMIN);
    const member = await this.getMembership(orgId, userId);
    if (!member) throw new NotFoundException('Member not found');
    this.assertCanAssign(callerRole, member.role);
    this.assertCanAssign(callerRole, role);
    if (member.role === OrganizationRole.OWNER && role !== OrganizationRole.OWNER) {
      await this.assertNotLastOwner(orgId);
    }
    return this.prisma.organizationMember.update({ where: { id: member.id }, data: { role } });
  }

  async removeMember(orgId: string, callerId: string, userId: string) {
    const member = await this.getMembership(orgId, userId);
    if (!member) throw new NotFoundException('Member not found');
    // Anyone may leave; removing others needs ADMIN and an equal-or-higher rank.
    if (userId !== callerId) {
      const callerRole = await this.requireRole(orgId, callerId, OrganizationRole.ADMIN);
      this.assertCanAssign(callerRole, member.role);
    }
    if (member.role === OrganizationRole.OWNER) await this.assertNotLastOwner(orgId);
    await this.prisma.organizationMember.delete({ where: { id: member.id } });
    return { removed: true };
  }

  getMembership(orgId: string, userId: string) {
    return this.prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
    });
  }

  /** Returns the caller's role, or throws 403 if below `minRole` / not a member. */
  async requireRole(orgId: string, userId: string, minRole: OrganizationRole) {
    const membership = await this.getMembership(orgId, userId);
    if (!membership) {
      const exists = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
      if (!exists) throw new NotFoundException(`Organization ${orgId} not found`);
      throw new ForbiddenException('Not a member of this organization');
    }
    if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      throw new ForbiddenException(`Requires organization role ${minRole}`);
    }
    return membership.role;
  }

  /** Stellar addresses of all members of an org the caller belongs to. */
  async getMemberAddresses(orgId: string, callerId: string): Promise<string[]> {
    await this.requireRole(orgId, callerId, OrganizationRole.VIEWER);
    const members = await this.prisma.organizationMember.findMany({
      where: { orgId },
      select: { user: { select: { stellarAddress: true } } },
    });
    return members.map((m) => m.user.stellarAddress);
  }

  /**
   * Highest org role the user holds in any organization that has a member
   * participating in the shipment, or null when there is none.
   */
  async getShipmentOrgRole(userId: string, shipment: ShipmentParticipants): Promise<OrganizationRole | null> {
    if (!userId) return null;
    const addresses = participantAddressesOf(shipment);
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        organization: { members: { some: { user: { stellarAddress: { in: addresses } } } } },
      },
      select: { role: true },
    });
    if (memberships.length === 0) return null;
    return memberships.reduce<OrganizationRole>(
      (best, m) => (ROLE_RANK[m.role] > ROLE_RANK[best] ? m.role : best),
      OrganizationRole.VIEWER,
    );
  }

  async canReadShipment(userId: string, shipment: ShipmentParticipants) {
    return (await this.getShipmentOrgRole(userId, shipment)) !== null;
  }

  /** VIEWERs are read-only; MEMBER and above may comment. */
  async canCommentOnShipment(userId: string, shipment: ShipmentParticipants) {
    const role = await this.getShipmentOrgRole(userId, shipment);
    return role !== null && ROLE_RANK[role] >= ROLE_RANK[OrganizationRole.MEMBER];
  }

  private assertCanAssign(callerRole: OrganizationRole, role: OrganizationRole) {
    if (ROLE_RANK[role] > ROLE_RANK[callerRole]) {
      throw new ForbiddenException(`A ${callerRole} cannot manage ${role} members`);
    }
  }

  private async assertNotLastOwner(orgId: string) {
    const owners = await this.prisma.organizationMember.count({
      where: { orgId, role: OrganizationRole.OWNER },
    });
    if (owners <= 1) throw new BadRequestException('An organization must keep at least one OWNER');
  }
}
