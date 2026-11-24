import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';

/**
 * Read-only access: shipment participants, admins, and members of an
 * organization that has a participant among its members (#435).
 * Use ShipmentParticipantGuard for anything that mutates a shipment.
 */
@Injectable()
export class ShipmentReadAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly organizations?: OrganizationsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as { id?: string; stellarAddress?: string; role?: UserRole };
    const shipmentId = (req.params?.id ?? req.params?.shipmentId) as string;

    if (!user?.stellarAddress) {
      throw new ForbiddenException('Missing authenticated user stellarAddress');
    }
    if (user.role === UserRole.ADMIN) return true;
    if (!shipmentId) throw new ForbiddenException('Missing shipment id');

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { buyerAddress: true, supplierAddress: true, logisticsAddress: true, arbiterAddress: true },
    });
    if (!shipment) throw new ForbiddenException(`Shipment ${shipmentId} not accessible`);

    const caller = user.stellarAddress;
    if (
      caller === shipment.buyerAddress ||
      caller === shipment.supplierAddress ||
      caller === shipment.logisticsAddress ||
      caller === shipment.arbiterAddress
    ) {
      return true;
    }

    if (user.id && (await this.organizations?.canReadShipment(user.id, shipment))) {
      req.shipmentAccess = 'organization';
      return true;
    }

    throw new ForbiddenException('Caller is not a participant in this shipment');
  }
}
