import { MilestoneGql } from './shipment.type';

export function toMilestoneGql(m: any): MilestoneGql {
  return {
    id: m.id,
    shipmentId: m.shipmentId,
    milestoneIndex: m.milestoneIndex,
    name: m.name,
    paymentPercent: m.paymentPercent,
    status: m.status,
    proofHash: m.proofHash ?? undefined,
    confirmedAt: m.confirmedAt ?? undefined,
    dueAt: m.dueAt ?? undefined,
    paymentReleased: m.paymentReleased != null ? m.paymentReleased.toString() : undefined,
    createdAt: m.createdAt ?? undefined,
  };
}
