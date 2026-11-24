import { MilestoneStatus, ArbiterStatus, KycStatus } from '@prisma/client';

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export interface RiskThresholds {
  highOpenDisputes: number;
  highOverdueMilestones: number;
  highInactiveDays: number;
  mediumInactiveDays: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  highOpenDisputes: 1,
  highOverdueMilestones: 2,
  highInactiveDays: 30,
  mediumInactiveDays: 14,
};

export interface RiskIndicators {
  overdueMilestones: number;
  openDisputes: number;
  arbiterNotAccepted: boolean;
  daysSinceLastActivity: number;
  unverifiedCounterparties: number;
}

export interface ShipmentRiskResult {
  shipmentId: string;
  level: RiskLevel;
  reasons: string[];
  indicators: RiskIndicators;
  evaluatedAt: string;
}

/**
 * Computes shipment risk indicators and derives overall risk level (LOW, MEDIUM, HIGH).
 *
 * Rules:
 *  - HIGH: openDisputes >= 1 OR overdueMilestones >= 2 OR daysSinceLastActivity >= 30 OR (overdueMilestones >= 1 AND arbiterNotAccepted)
 *  - MEDIUM (if not HIGH): overdueMilestones == 1 OR arbiterNotAccepted OR daysSinceLastActivity >= 14 OR unverifiedCounterparties >= 1
 *  - LOW: All indicators within normal parameters
 */
export function computeShipmentRisk(
  shipment: any,
  now: Date = new Date(),
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): ShipmentRiskResult {
  const milestones = Array.isArray(shipment.milestones) ? shipment.milestones : [];

  // 1. overdueMilestones: not completed/resolved, dueAt in the past
  const overdueMilestones = milestones.filter((m: any) => {
    if (m.deletedAt) return false;
    if (m.status === MilestoneStatus.CONFIRMED || m.status === MilestoneStatus.RESOLVED) {
      return false;
    }
    return m.dueAt && new Date(m.dueAt).getTime() < now.getTime();
  }).length;

  // 2. openDisputes: milestone status is DISPUTED
  const openDisputes = milestones.filter(
    (m: any) => !m.deletedAt && m.status === MilestoneStatus.DISPUTED,
  ).length;

  // 3. arbiterNotAccepted: arbiterStatus !== ACCEPTED
  const arbiterNotAccepted = shipment.arbiterStatus !== ArbiterStatus.ACCEPTED;

  // 4. daysSinceLastActivity: max timestamp among shipment updates, milestones, tracking, comments
  const activityTimestamps: number[] = [
    new Date(shipment.updatedAt ?? shipment.createdAt ?? now).getTime(),
  ];

  for (const m of milestones) {
    if (m.updatedAt) activityTimestamps.push(new Date(m.updatedAt).getTime());
    if (m.createdAt) activityTimestamps.push(new Date(m.createdAt).getTime());
  }

  if (Array.isArray(shipment.trackingUpdates)) {
    for (const t of shipment.trackingUpdates) {
      if (t.createdAt) activityTimestamps.push(new Date(t.createdAt).getTime());
    }
  }

  if (Array.isArray(shipment.comments)) {
    for (const c of shipment.comments) {
      if (c.createdAt) activityTimestamps.push(new Date(c.createdAt).getTime());
    }
  }

  const latestActivityTimestamp = Math.max(...activityTimestamps);
  const daysSinceLastActivity = Math.max(
    0,
    Math.floor((now.getTime() - latestActivityTimestamp) / (1000 * 60 * 60 * 24)),
  );

  // 5. unverifiedCounterparties: counterparties with kycStatus !== VERIFIED
  const counterparties = [
    shipment.buyer,
    shipment.supplier,
    shipment.logistics,
    shipment.arbiter,
  ];

  let unverifiedCounterparties = 0;
  for (const cp of counterparties) {
    if (!cp || cp.kycStatus !== KycStatus.VERIFIED) {
      unverifiedCounterparties++;
    }
  }

  // Derive level and reasons
  const reasons: string[] = [];

  const isHighRisk =
    openDisputes >= thresholds.highOpenDisputes ||
    overdueMilestones >= thresholds.highOverdueMilestones ||
    daysSinceLastActivity >= thresholds.highInactiveDays ||
    (overdueMilestones >= 1 && arbiterNotAccepted);

  const isMediumRisk =
    overdueMilestones === 1 ||
    arbiterNotAccepted ||
    daysSinceLastActivity >= thresholds.mediumInactiveDays ||
    unverifiedCounterparties >= 1;

  let level: RiskLevel = RiskLevel.LOW;
  if (isHighRisk) {
    level = RiskLevel.HIGH;
  } else if (isMediumRisk) {
    level = RiskLevel.MEDIUM;
  } else {
    level = RiskLevel.LOW;
  }

  if (openDisputes > 0) {
    reasons.push(`${openDisputes} open dispute(s)`);
  }
  if (overdueMilestones > 0) {
    reasons.push(`${overdueMilestones} overdue milestone(s)`);
  }
  if (arbiterNotAccepted) {
    reasons.push(
      `Arbiter has not accepted assignment (status: ${shipment.arbiterStatus ?? 'PENDING_ACCEPTANCE'})`,
    );
  }
  if (daysSinceLastActivity >= thresholds.highInactiveDays) {
    reasons.push(
      `No activity for ${daysSinceLastActivity} days (exceeds ${thresholds.highInactiveDays}-day threshold)`,
    );
  } else if (daysSinceLastActivity >= thresholds.mediumInactiveDays) {
    reasons.push(
      `No activity for ${daysSinceLastActivity} days (exceeds ${thresholds.mediumInactiveDays}-day threshold)`,
    );
  }
  if (unverifiedCounterparties > 0) {
    reasons.push(`${unverifiedCounterparties} counterparty(ies) have not completed KYC verification`);
  }

  return {
    shipmentId: shipment.id,
    level,
    reasons,
    indicators: {
      overdueMilestones,
      openDisputes,
      arbiterNotAccepted,
      daysSinceLastActivity,
      unverifiedCounterparties,
    },
    evaluatedAt: now.toISOString(),
  };
}
