import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Product identifier advertised in the generated calendars. */
const PRODID = '-//ChainSettle//Milestone Due Dates//EN';

/** How long a milestone due date occupies in a calendar, in minutes. */
const EVENT_DURATION_MINUTES = 30;

/** A single milestone rendered into the feed. */
export interface CalendarMilestone {
  id: string;
  shipmentId: string;
  milestoneIndex: number;
  name: string;
  status: string;
  dueAt: Date | null;
}

/**
 * iCalendar (RFC 5545) export of milestone due dates.
 *
 * Two feeds are served: one per shipment, and one per user aggregating every
 * shipment they participate in. The per-user feed is meant to be subscribed to
 * by a calendar app, which cannot send an Authorization header, so it is
 * authenticated by a signed token in the URL instead.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);
  private readonly feedSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.feedSecret = this.config.get<string>('CALENDAR_FEED_SECRET', '');
  }

  // -- Token handling ---------------------------------------------------------

  /**
   * Mint a subscription token for a user.
   *
   * The token carries the user id and an HMAC over it, so it identifies its
   * owner without a lookup and cannot be forged or edited to point at another
   * user. It does not expire: a calendar subscription is long-lived, and
   * rotating CALENDAR_FEED_SECRET revokes every issued token at once.
   */
  issueToken(userId: string): string {
    this.assertSecretConfigured();
    const signature = this.sign(userId);
    return `${Buffer.from(userId).toString('base64url')}.${signature}`;
  }

  /**
   * Resolve a subscription token back to its user id.
   *
   * @throws {UnauthorizedException} When the token is malformed, or its
   *   signature does not match.
   */
  verifyToken(token: string): string {
    this.assertSecretConfigured();

    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('Invalid calendar token');
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException('Invalid calendar token');
    }

    const [encodedUserId, signature] = parts;

    let userId: string;
    try {
      userId = Buffer.from(encodedUserId, 'base64url').toString('utf8');
    } catch {
      throw new UnauthorizedException('Invalid calendar token');
    }

    if (!userId) {
      throw new UnauthorizedException('Invalid calendar token');
    }

    const expected = this.sign(userId);

    // Constant-time comparison: a token check is an auth check, and a timing
    // side channel would let a signature be recovered byte by byte.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid calendar token');
    }

    return userId;
  }

  private sign(userId: string): string {
    return createHmac('sha256', this.feedSecret).update(userId).digest('base64url');
  }

  private assertSecretConfigured(): void {
    if (!this.feedSecret) {
      throw new UnauthorizedException(
        'Calendar feeds are not configured on this deployment',
      );
    }
  }

  // -- Data ------------------------------------------------------------------

  /** Milestones with a due date for one shipment, earliest first. */
  async getShipmentMilestones(shipmentId: string): Promise<CalendarMilestone[]> {
    return this.prisma.milestone.findMany({
      where: { shipmentId, dueAt: { not: null } },
      orderBy: { dueAt: 'asc' },
      select: {
        id: true,
        shipmentId: true,
        milestoneIndex: true,
        name: true,
        status: true,
        dueAt: true,
      },
    }) as unknown as Promise<CalendarMilestone[]>;
  }

  /**
   * Milestones with a due date across every shipment the user participates in.
   *
   * Participation is matched on the user's Stellar address appearing in any of
   * the four shipment roles, so the feed can never include a shipment the
   * token's owner is not party to.
   */
  async getUserMilestones(userId: string): Promise<CalendarMilestone[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stellarAddress: true },
    });

    if (!user) return [];

    const address = user.stellarAddress;

    return this.prisma.milestone.findMany({
      where: {
        dueAt: { not: null },
        shipment: {
          OR: [
            { buyerAddress: address },
            { supplierAddress: address },
            { logisticsAddress: address },
            { arbiterAddress: address },
          ],
        },
      },
      orderBy: { dueAt: 'asc' },
      select: {
        id: true,
        shipmentId: true,
        milestoneIndex: true,
        name: true,
        status: true,
        dueAt: true,
      },
    }) as unknown as Promise<CalendarMilestone[]>;
  }

  // -- iCalendar rendering ----------------------------------------------------

  /**
   * Escape a value for a text property, per RFC 5545 section 3.3.11.
   *
   * Backslash first, or the escapes introduced below would be escaped again.
   */
  private escapeText(value: string): string {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\n|\r/g, '\\n');
  }

  /** Format a date as a UTC timestamp, e.g. 20260630T235959Z. */
  private formatUtc(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /**
   * Fold a content line to 75 octets, per RFC 5545 section 3.1.
   *
   * Folding counts octets rather than characters, so a multi-byte character is
   * never split across a fold boundary.
   */
  private foldLine(line: string): string {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;

    const parts: string[] = [];
    let start = 0;
    let limit = 75;

    while (start < bytes.length) {
      let end = Math.min(start + limit, bytes.length);

      // Do not split a multi-byte sequence: back off to a lead byte.
      if (end < bytes.length) {
        while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
      }

      parts.push(bytes.subarray(start, end).toString('utf8'));
      start = end;
      // Continuation lines carry a leading space, which counts toward the 75.
      limit = 74;
    }

    return parts.join('\r\n ');
  }

  /** Render one milestone as a VEVENT. */
  private renderEvent(milestone: CalendarMilestone, stamp: string): string[] {
    const due = milestone.dueAt as Date;
    const end = new Date(due.getTime() + EVENT_DURATION_MINUTES * 60_000);

    const summary = `${milestone.name} due (${milestone.shipmentId})`;
    const description =
      `Milestone ${milestone.milestoneIndex} on shipment ${milestone.shipmentId}. ` +
      `Status: ${milestone.status}.`;

    return [
      'BEGIN:VEVENT',
      // Stable per milestone, so re-subscribing updates events rather than
      // duplicating them.
      `UID:milestone-${milestone.id}@chainsettle`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${this.formatUtc(due)}`,
      `DTEND:${this.formatUtc(end)}`,
      `SUMMARY:${this.escapeText(summary)}`,
      `DESCRIPTION:${this.escapeText(description)}`,
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    ];
  }

  /**
   * Render a set of milestones as a complete iCalendar document.
   *
   * Lines are joined with CRLF and the document ends with one, as the spec
   * requires. An empty set still produces a valid, empty VCALENDAR: a
   * subscribed calendar app expects a parseable body, not a 404.
   */
  render(
    milestones: CalendarMilestone[],
    calendarName: string,
    now: Date = new Date(),
  ): string {
    const stamp = this.formatUtc(now);

    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${PRODID}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${this.escapeText(calendarName)}`,
    ];

    for (const milestone of milestones) {
      if (!milestone.dueAt) continue;
      lines.push(...this.renderEvent(milestone, stamp));
    }

    lines.push('END:VCALENDAR');

    return lines.map((line) => this.foldLine(line)).join('\r\n') + '\r\n';
  }

  /** The .ics document for a single shipment. */
  async renderShipmentCalendar(shipmentId: string): Promise<string> {
    const milestones = await this.getShipmentMilestones(shipmentId);
    return this.render(milestones, `Shipment ${shipmentId} milestones`);
  }

  /** The .ics document for every shipment a user participates in. */
  async renderUserCalendar(userId: string): Promise<string> {
    const milestones = await this.getUserMilestones(userId);
    return this.render(milestones, 'ChainSettle milestone due dates');
  }
}
