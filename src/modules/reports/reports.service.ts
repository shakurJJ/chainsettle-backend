import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PAST_MONTH_TTL_S = 7 * 24 * 60 * 60;
const CURRENT_MONTH_TTL_S = 15 * 60;

export interface StatementLine {
  date: Date;
  type: 'SHIPMENT_CREATED' | 'PAYMENT_RELEASED' | 'REFUND';
  role: 'BUYER' | 'SUPPLIER';
  shipmentId: string;
  amount: bigint;
  token: string;
}

export interface StatementData {
  month: string;
  address: string;
  lines: StatementLine[];
  totals: {
    shipmentsCreated: number;
    shipmentVolume: bigint;
    paymentsReleased: bigint;
    refunds: bigint;
  };
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  static monthRange(month: string): { start: Date; end: Date } {
    const m = MONTH_PATTERN.exec(month);
    if (!m) throw new BadRequestException('month must be in YYYY-MM format');
    const year = Number(m[1]);
    const mon = Number(m[2]) - 1;
    const start = new Date(Date.UTC(year, mon, 1));
    if (start.getTime() > Date.now()) {
      throw new BadRequestException('month must not be in the future');
    }
    return { start, end: new Date(Date.UTC(year, mon + 1, 1)) };
  }

  /** Aggregates the caller's activity as buyer and supplier for the month. */
  async buildStatement(address: string, month: string): Promise<StatementData> {
    const { start, end } = ReportsService.monthRange(month);
    const db = this.prisma.jobs;
    const party = { OR: [{ buyerAddress: address }, { supplierAddress: address }] };
    const roleOf = (s: { buyerAddress: string }) =>
      (s.buyerAddress === address ? 'BUYER' : 'SUPPLIER') as StatementLine['role'];

    const [created, released, cancelled] = await Promise.all([
      db.shipment.findMany({
        where: { ...party, createdAt: { gte: start, lt: end } },
        select: { id: true, buyerAddress: true, totalAmount: true, tokenSymbol: true, createdAt: true },
      }),
      db.milestone.findMany({
        where: {
          confirmedAt: { gte: start, lt: end },
          paymentReleased: { not: null },
          shipment: party,
        },
        select: {
          shipmentId: true,
          paymentReleased: true,
          confirmedAt: true,
          shipment: { select: { buyerAddress: true, tokenSymbol: true } },
        },
      }),
      db.shipment.findMany({
        where: { ...party, cancelledAt: { gte: start, lt: end } },
        select: {
          id: true,
          buyerAddress: true,
          totalAmount: true,
          releasedAmount: true,
          tokenSymbol: true,
          cancelledAt: true,
        },
      }),
    ]);

    const lines: StatementLine[] = [
      ...created.map((s) => ({
        date: s.createdAt,
        type: 'SHIPMENT_CREATED' as const,
        role: roleOf(s),
        shipmentId: s.id,
        amount: s.totalAmount,
        token: s.tokenSymbol,
      })),
      ...released.map((m) => ({
        date: m.confirmedAt!,
        type: 'PAYMENT_RELEASED' as const,
        role: roleOf(m.shipment),
        shipmentId: m.shipmentId,
        amount: m.paymentReleased!,
        token: m.shipment.tokenSymbol,
      })),
      ...cancelled.map((s) => ({
        date: s.cancelledAt!,
        type: 'REFUND' as const,
        role: roleOf(s),
        shipmentId: s.id,
        amount: s.totalAmount - s.releasedAmount,
        token: s.tokenSymbol,
      })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());

    const sum = (type: StatementLine['type']) =>
      lines.filter((l) => l.type === type).reduce((acc, l) => acc + l.amount, 0n);

    return {
      month,
      address,
      lines,
      totals: {
        shipmentsCreated: created.length,
        shipmentVolume: sum('SHIPMENT_CREATED'),
        paymentsReleased: sum('PAYMENT_RELEASED'),
        refunds: sum('REFUND'),
      },
    };
  }

  /** Returns the statement PDF, cached per user and month. */
  async getStatementPdf(address: string, month: string): Promise<Buffer> {
    ReportsService.monthRange(month);
    const key = `chainsettle:statements:${address}:${month}`;
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return Buffer.from(cached, 'base64');

    const pdf = await this.renderPdf(await this.buildStatement(address, month));

    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const ttl = month === currentMonth ? CURRENT_MONTH_TTL_S : PAST_MONTH_TTL_S;
    await this.redis.set(key, pdf.toString('base64'), ttl).catch((err) => {
      this.logger.warn(`Failed to cache statement ${key}: ${err.message}`);
    });
    return pdf;
  }

  private formatAmount(amount: bigint, decimals = 7): string {
    const neg = amount < 0n;
    const abs = neg ? -amount : amount;
    const base = 10n ** BigInt(decimals);
    const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
  }

  renderPdf(data: StatementData): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('ChainSettle — Monthly Account Statement');
      doc.moveDown(0.5).fontSize(10);
      doc.text(`Account: ${data.address}`);
      doc.text(`Period: ${data.month}`);
      doc.text(`Generated: ${new Date().toISOString()}`);

      doc.moveDown().fontSize(12).text('Summary');
      doc.fontSize(10);
      doc.text(`Shipments created: ${data.totals.shipmentsCreated}`);
      doc.text(`Shipment volume: ${this.formatAmount(data.totals.shipmentVolume)}`);
      doc.text(`Payments released: ${this.formatAmount(data.totals.paymentsReleased)}`);
      doc.text(`Refunds: ${this.formatAmount(data.totals.refunds)}`);

      doc.moveDown().fontSize(12).text('Activity');
      doc.fontSize(9);
      if (data.lines.length === 0) {
        doc.text('No activity this month.');
      }
      for (const l of data.lines) {
        doc.text(
          `${l.date.toISOString().slice(0, 10)}  ${l.type.padEnd(17)} ${l.role.padEnd(9)} ${l.shipmentId}  ${this.formatAmount(l.amount)} ${l.token}`,
        );
      }
      doc.end();
    });
  }
}
