import { Injectable } from '@nestjs/common';
import { MilestoneStatus, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportFrequency } from './notifications.service';

/** A milestone still waiting on someone — used for overdue/upcoming lists. */
const OPEN_MILESTONE_STATUSES: MilestoneStatus[] = [
  MilestoneStatus.PENDING,
  MilestoneStatus.PROOF_SUBMITTED,
];

const UPCOMING_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound so one user's report never loads an unbounded history. */
const MAX_REPORT_SHIPMENTS = 500;

export type ReportShipmentRole =
  'BUYER' | 'SUPPLIER' | 'LOGISTICS' | 'ARBITER' | 'OBSERVER';

export interface ReportMilestone {
  milestoneIndex: number;
  name: string;
  status: MilestoneStatus;
  dueAt: Date | null;
}

export interface ReportShipment {
  id: string;
  referenceNumber: string | null;
  status: ShipmentStatus;
  buyerAddress: string;
  supplierAddress: string;
  logisticsAddress: string;
  arbiterAddress: string;
  totalAmount: bigint | number;
  releasedAmount: bigint | number;
  tokenSymbol: string;
  tokenDecimals: number;
  createdAt: Date;
  updatedAt: Date;
  milestones?: ReportMilestone[];
}

export interface ReportMilestoneDue {
  shipmentId: string;
  referenceNumber: string | null;
  milestoneIndex: number;
  name: string;
  dueAt: Date;
}

export interface ShipmentReportStats {
  totalShipments: number;
  activeShipments: number;
  completedShipments: number;
  cancelledShipments: number;
  createdInPeriod: number;
  updatedInPeriod: number;
  roles: Record<ReportShipmentRole, number>;
  /** Outstanding escrow (total − released) per token, formatted for display. */
  escrowByToken: Record<string, string>;
  overdueMilestones: ReportMilestoneDue[];
  upcomingMilestones: ReportMilestoneDue[];
}

export interface ShipmentReportSummary {
  subject: string;
  html: string;
  stats: ShipmentReportStats;
}

/**
 * Formats a stroop-style integer amount for display, trimming trailing zeros.
 * Kept dependency-free so the summary builder stays a pure function.
 */
export function formatTokenAmount(
  amount: bigint | number | null | undefined,
  decimals = 7,
): string {
  if (amount === null || amount === undefined) return '0';
  const value =
    typeof amount === 'bigint' ? amount : BigInt(Math.trunc(amount));
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const places = Math.max(0, decimals);
  const base = BigInt(10) ** BigInt(places);
  const whole = abs / base;
  const fraction = (abs % base)
    .toString()
    .padStart(places, '0')
    .replace(/0+$/, '');
  const formatted = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${formatted}` : formatted;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function roleFor(
  shipment: ReportShipment,
  stellarAddress: string,
): ReportShipmentRole {
  if (shipment.buyerAddress === stellarAddress) return 'BUYER';
  if (shipment.supplierAddress === stellarAddress) return 'SUPPLIER';
  if (shipment.logisticsAddress === stellarAddress) return 'LOGISTICS';
  if (shipment.arbiterAddress === stellarAddress) return 'ARBITER';
  return 'OBSERVER';
}

function dueLabel(dueAt: Date): string {
  return dueAt.toISOString().slice(0, 10);
}

function milestoneListHtml(title: string, items: ReportMilestoneDue[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map(
      (m) =>
        `<li><strong>${escapeHtml(m.name)}</strong> — ${escapeHtml(
          m.referenceNumber ?? m.shipmentId,
        )} — due ${escapeHtml(dueLabel(m.dueAt))}</li>`,
    )
    .join('');
  return `<h3 style="color:#1a1a2e;">${escapeHtml(title)} (${items.length})</h3><ul>${rows}</ul>`;
}

/**
 * Builds the per-user shipment summary. Pure (no I/O) so it can be unit
 * tested directly; `ShipmentReportService.buildForUser` supplies the rows.
 * Returns null when the user has no shipments to report on.
 */
export function buildShipmentReportSummary(input: {
  stellarAddress: string;
  frequency: Exclude<ReportFrequency, 'off'>;
  shipments: ReportShipment[];
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}): ShipmentReportSummary | null {
  const { stellarAddress, frequency, shipments, periodStart, periodEnd, now } =
    input;

  if (shipments.length === 0) return null;

  const roles: Record<ReportShipmentRole, number> = {
    BUYER: 0,
    SUPPLIER: 0,
    LOGISTICS: 0,
    ARBITER: 0,
    OBSERVER: 0,
  };

  let activeShipments = 0;
  let completedShipments = 0;
  let cancelledShipments = 0;
  let createdInPeriod = 0;
  let updatedInPeriod = 0;
  const escrow = new Map<string, bigint>();
  const overdueMilestones: ReportMilestoneDue[] = [];
  const upcomingMilestones: ReportMilestoneDue[] = [];
  const upcomingCutoff = new Date(
    now.getTime() + UPCOMING_WINDOW_DAYS * DAY_MS,
  );

  for (const shipment of shipments) {
    roles[roleFor(shipment, stellarAddress)] += 1;

    if (shipment.status === ShipmentStatus.ACTIVE) activeShipments += 1;
    else if (shipment.status === ShipmentStatus.COMPLETED)
      completedShipments += 1;
    else if (shipment.status === ShipmentStatus.CANCELLED)
      cancelledShipments += 1;

    if (shipment.createdAt >= periodStart && shipment.createdAt <= periodEnd) {
      createdInPeriod += 1;
    }
    if (shipment.updatedAt >= periodStart && shipment.updatedAt <= periodEnd) {
      updatedInPeriod += 1;
    }

    if (shipment.status === ShipmentStatus.ACTIVE) {
      const outstanding =
        BigInt(shipment.totalAmount) - BigInt(shipment.releasedAmount);
      const symbol = shipment.tokenSymbol || 'TOKEN';
      const decimals =
        typeof shipment.tokenDecimals === 'number' ? shipment.tokenDecimals : 7;
      const entry = escrow.get(`${symbol}:${decimals}`) ?? BigInt(0);
      escrow.set(
        `${symbol}:${decimals}`,
        entry + (outstanding > BigInt(0) ? outstanding : BigInt(0)),
      );
    }

    for (const milestone of shipment.milestones ?? []) {
      if (!milestone.dueAt) continue;
      if (!OPEN_MILESTONE_STATUSES.includes(milestone.status)) continue;

      const item: ReportMilestoneDue = {
        shipmentId: shipment.id,
        referenceNumber: shipment.referenceNumber,
        milestoneIndex: milestone.milestoneIndex,
        name: milestone.name,
        dueAt: milestone.dueAt,
      };

      if (milestone.dueAt < now) {
        overdueMilestones.push(item);
      } else if (milestone.dueAt <= upcomingCutoff) {
        upcomingMilestones.push(item);
      }
    }
  }

  const byDueDate = (a: ReportMilestoneDue, b: ReportMilestoneDue) =>
    a.dueAt.getTime() - b.dueAt.getTime();
  overdueMilestones.sort(byDueDate);
  upcomingMilestones.sort(byDueDate);

  const escrowByToken: Record<string, string> = {};
  for (const [key, amount] of escrow) {
    const [symbol, decimals] = key.split(':');
    const formatted = formatTokenAmount(amount, Number(decimals));
    escrowByToken[symbol] = formatted;
  }

  const stats: ShipmentReportStats = {
    totalShipments: shipments.length,
    activeShipments,
    completedShipments,
    cancelledShipments,
    createdInPeriod,
    updatedInPeriod,
    roles,
    escrowByToken,
    overdueMilestones,
    upcomingMilestones,
  };

  const frequencyLabel = frequency === 'monthly' ? 'monthly' : 'weekly';
  const escrowRows = Object.entries(escrowByToken)
    .map(
      ([symbol, amount]) =>
        `<li><strong>${escapeHtml(amount)} ${escapeHtml(symbol)}</strong> still held in escrow</li>`,
    )
    .join('');

  const roleRows = (Object.keys(roles) as ReportShipmentRole[])
    .filter((role) => roles[role] > 0)
    .map((role) => `<li>${escapeHtml(role)}: ${roles[role]}</li>`)
    .join('');

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">ChainSettle — Your ${frequencyLabel} shipment report</h2>
      <p>
        ${escapeHtml(dueLabel(periodStart))} → ${escapeHtml(dueLabel(periodEnd))}
      </p>
      <h3 style="color:#1a1a2e;">Shipments (${stats.totalShipments})</h3>
      <ul>
        <li>Active: ${stats.activeShipments}</li>
        <li>Completed: ${stats.completedShipments}</li>
        <li>Cancelled: ${stats.cancelledShipments}</li>
        <li>Updated this period: ${stats.updatedInPeriod}</li>
        <li>Created this period: ${stats.createdInPeriod}</li>
      </ul>
      ${roleRows ? `<h3 style="color:#1a1a2e;">Your roles</h3><ul>${roleRows}</ul>` : ''}
      ${escrowRows ? `<h3 style="color:#1a1a2e;">Outstanding escrow</h3><ul>${escrowRows}</ul>` : ''}
      ${milestoneListHtml('Overdue milestones', overdueMilestones)}
      ${milestoneListHtml('Milestones due in the next 7 days', upcomingMilestones)}
      ${
        overdueMilestones.length === 0 && upcomingMilestones.length === 0
          ? '<p>No open milestones are due in the next 7 days.</p>'
          : ''
      }
      <hr />
      <small style="color:#888;">Log in to ChainSettle to review these shipments.</small>
    </div>
  `;

  return {
    subject: `Your ${frequencyLabel} shipment report — ${activeShipments} active shipment(s)`,
    html,
    stats,
  };
}

@Injectable()
export class ShipmentReportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Loads the caller's shipments and builds their report. The preference is
   * validated by the caller; `off` produces no report.
   */
  async buildForUser(
    userId: string,
    frequency: ReportFrequency,
    now: Date = new Date(),
  ): Promise<ShipmentReportSummary | null> {
    if (frequency === 'off') return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stellarAddress: true },
    });
    if (!user) return null;

    const periodDays = frequency === 'monthly' ? 30 : 7;
    const periodEnd = now;
    const periodStart = new Date(now.getTime() - periodDays * DAY_MS);

    const shipments = await this.prisma.shipment.findMany({
      where: {
        isDraft: false,
        OR: [
          { buyerAddress: user.stellarAddress },
          { supplierAddress: user.stellarAddress },
          { logisticsAddress: user.stellarAddress },
          { arbiterAddress: user.stellarAddress },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_REPORT_SHIPMENTS,
      select: {
        id: true,
        referenceNumber: true,
        status: true,
        buyerAddress: true,
        supplierAddress: true,
        logisticsAddress: true,
        arbiterAddress: true,
        totalAmount: true,
        releasedAmount: true,
        tokenSymbol: true,
        tokenDecimals: true,
        createdAt: true,
        updatedAt: true,
        milestones: {
          select: {
            milestoneIndex: true,
            name: true,
            status: true,
            dueAt: true,
          },
        },
      },
    });

    return buildShipmentReportSummary({
      stellarAddress: user.stellarAddress,
      frequency,
      shipments: shipments as ReportShipment[],
      periodStart,
      periodEnd,
      now,
    });
  }
}
