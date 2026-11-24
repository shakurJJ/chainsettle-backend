import { ForbiddenException } from '@nestjs/common';

type Participants = {
  buyerAddress: string;
  supplierAddress: string;
  logisticsAddress: string;
  arbiterAddress: string;
};

/** Same participant rule the REST API applies: parties to the shipment, or an admin. */
export function isParticipant(shipment: Participants, user: { stellarAddress?: string; role?: string }): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return [shipment.buyerAddress, shipment.supplierAddress, shipment.logisticsAddress, shipment.arbiterAddress].includes(
    user.stellarAddress as string,
  );
}

export function assertParticipant(shipment: Participants, user: any): void {
  if (!isParticipant(shipment, user)) {
    throw new ForbiddenException('Not a participant on this shipment');
  }
}
