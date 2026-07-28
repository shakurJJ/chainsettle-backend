import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class ShipmentParticipantGuard implements CanActivate {
    constructor(
        private readonly prisma: PrismaService,
        // Kept for future extensibility (e.g., metadata overrides)
        private readonly reflector: Reflector,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const user = req.user as { stellarAddress?: string; role?: UserRole };
        const params = context.switchToHttp().getRequest()?.params ?? {};
        const shipmentId = (params.id ?? params.shipmentId) as string;

        if (!user?.stellarAddress) {
            throw new ForbiddenException('Missing authenticated user stellarAddress');
        }

        // ADMIN bypass
        if (user.role === UserRole.ADMIN) return true;

        if (!shipmentId) {
            throw new ForbiddenException('Missing shipment id');
        }

        const shipment = await this.prisma.shipment.findUnique({
            where: { id: shipmentId },
            select: {
                buyerAddress: true,
                supplierAddress: true,
                logisticsAddress: true,
                arbiterAddress: true,
            },
        });

        // For security: treat unknown shipment as not accessible
        if (!shipment) {
            throw new ForbiddenException(`Shipment ${shipmentId} not accessible`);
        }

        const { buyerAddress, supplierAddress, logisticsAddress, arbiterAddress } = shipment;
        const caller = user.stellarAddress;

        const isParticipant =
            caller === buyerAddress ||
            caller === supplierAddress ||
            caller === logisticsAddress ||
            caller === arbiterAddress;

        if (!isParticipant) {
            throw new ForbiddenException('Caller is not a participant in this shipment');
        }

        return true;
    }
}

