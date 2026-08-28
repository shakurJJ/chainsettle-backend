import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { CalendarService, CalendarMilestone } from './calendar.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const SECRET = 'test-calendar-secret';

describe('CalendarService', () => {
  let service: CalendarService;
  let prisma: {
    milestone: { findMany: jest.Mock };
    user: { findUnique: jest.Mock };
  };

  function milestone(overrides: Partial<CalendarMilestone> = {}): CalendarMilestone {
    return {
      id: 'm-1',
      shipmentId: 'SHIP-1',
      milestoneIndex: 0,
      name: 'Goods Dispatched',
      status: 'PENDING',
      dueAt: new Date('2026-06-30T23:59:59.000Z'),
      ...overrides,
    };
  }

  /** Split a rendered calendar into unfolded logical lines. */
  function logicalLines(ics: string): string[] {
    return ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
  }

  beforeEach(async () => {
    prisma = {
      milestone: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(SECRET) },
        },
      ],
    }).compile();

    service = module.get<CalendarService>(CalendarService);
  });

  // -- Document structure -----------------------------------------------------

  describe('document structure', () => {
    it('wraps events in a VCALENDAR with the required properties', () => {
      const ics = service.render([milestone()], 'Test calendar');
      const lines = logicalLines(ics);

      expect(lines[0]).toBe('BEGIN:VCALENDAR');
      expect(lines).toContain('VERSION:2.0');
      expect(lines).toContain('CALSCALE:GREGORIAN');
      expect(lines.some((l) => l.startsWith('PRODID:'))).toBe(true);
      expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    });

    it('separates lines with CRLF and terminates the document with one', () => {
      const ics = service.render([milestone()], 'Test calendar');

      expect(ics.endsWith('\r\n')).toBe(true);
      // No bare LF anywhere: every LF must be preceded by CR.
      expect(/[^\r]\n/.test(ics)).toBe(false);
    });

    it('produces a valid empty calendar when nothing is due', () => {
      const ics = service.render([], 'Empty calendar');
      const lines = logicalLines(ics);

      // A subscribed calendar app expects a parseable body, not an error.
      expect(lines[0]).toBe('BEGIN:VCALENDAR');
      expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
      expect(ics).not.toContain('BEGIN:VEVENT');
    });

    it('balances every BEGIN with an END', () => {
      const ics = service.render([milestone(), milestone({ id: 'm-2' })], 'Cal');

      expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(2);
      expect((ics.match(/END:VEVENT/g) || []).length).toBe(2);
      expect((ics.match(/BEGIN:VCALENDAR/g) || []).length).toBe(1);
      expect((ics.match(/END:VCALENDAR/g) || []).length).toBe(1);
    });
  });

  // -- Events -----------------------------------------------------------------

  describe('events', () => {
    it('renders the due date as a UTC timestamp', () => {
      const ics = service.render([milestone()], 'Cal');

      expect(ics).toContain('DTSTART:20260630T235959Z');
    });

    it('gives the event an end after its start', () => {
      const lines = logicalLines(service.render([milestone()], 'Cal'));
      const start = lines.find((l) => l.startsWith('DTSTART:')) as string;
      const end = lines.find((l) => l.startsWith('DTEND:')) as string;

      expect(end.slice(6) > start.slice(8)).toBe(true);
    });

    it('gives each milestone a stable UID so re-subscribing updates in place', () => {
      const first = service.render([milestone()], 'Cal');
      const second = service.render([milestone()], 'Cal');

      expect(first).toContain('UID:milestone-m-1@chainsettle');
      expect(second).toContain('UID:milestone-m-1@chainsettle');
    });

    it('gives different milestones different UIDs', () => {
      const ics = service.render(
        [milestone({ id: 'm-1' }), milestone({ id: 'm-2' })],
        'Cal',
      );

      expect(ics).toContain('UID:milestone-m-1@chainsettle');
      expect(ics).toContain('UID:milestone-m-2@chainsettle');
    });

    it('names the milestone and its shipment in the summary', () => {
      const ics = service.render([milestone()], 'Cal');

      expect(ics).toContain('Goods Dispatched due');
      expect(ics).toContain('SHIP-1');
    });

    it('stamps every event with DTSTAMP', () => {
      const ics = service.render([milestone()], 'Cal', new Date('2026-01-02T03:04:05Z'));

      expect(ics).toContain('DTSTAMP:20260102T030405Z');
    });

    it('skips milestones with no due date', () => {
      const ics = service.render(
        [milestone({ id: 'm-1' }), milestone({ id: 'm-2', dueAt: null })],
        'Cal',
      );

      expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(1);
      expect(ics).toContain('milestone-m-1@');
      expect(ics).not.toContain('milestone-m-2@');
    });
  });

  // -- Escaping and folding ---------------------------------------------------

  describe('text escaping', () => {
    it('escapes commas and semicolons in a milestone name', () => {
      const ics = service.render(
        [milestone({ name: 'Customs; cleared, finally' })],
        'Cal',
      );
      const summary = logicalLines(ics).find((l) =>
        l.startsWith('SUMMARY:'),
      ) as string;

      expect(summary).toContain('\\;');
      expect(summary).toContain('\\,');
    });

    it('escapes backslashes without double-escaping the escapes it adds', () => {
      const ics = service.render([milestone({ name: 'a\\b,c' })], 'Cal');
      const summary = logicalLines(ics).find((l) =>
        l.startsWith('SUMMARY:'),
      ) as string;

      expect(summary).toContain('a\\\\b');
      expect(summary).toContain('\\,c');
    });

    it('turns newlines in a name into the literal escape, not a real break', () => {
      const ics = service.render([milestone({ name: 'line1\nline2' })], 'Cal');

      expect(ics).toContain('line1\\nline2');
      // The document must not gain an unfolded raw line from the value.
      expect(logicalLines(ics)).not.toContain('line2');
    });

    it('escapes the calendar name too', () => {
      const ics = service.render([], 'Bob, Alice; shipments');
      const name = logicalLines(ics).find((l) =>
        l.startsWith('X-WR-CALNAME:'),
      ) as string;

      expect(name).toContain('\\,');
      expect(name).toContain('\\;');
    });
  });

  describe('line folding', () => {
    it('folds content lines longer than 75 octets', () => {
      const ics = service.render([milestone({ name: 'x'.repeat(200) })], 'Cal');

      for (const line of ics.split('\r\n')) {
        expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
      }
    });

    it('marks continuation lines with a leading space', () => {
      const ics = service.render([milestone({ name: 'y'.repeat(200) })], 'Cal');
      const raw = ics.split('\r\n');
      const folded = raw.filter((l) => l.startsWith(' '));

      expect(folded.length).toBeGreaterThan(0);
    });

    it('unfolds back to the original value', () => {
      const long = 'z'.repeat(200);
      const ics = service.render([milestone({ name: long })], 'Cal');
      const summary = logicalLines(ics).find((l) =>
        l.startsWith('SUMMARY:'),
      ) as string;

      expect(summary).toContain(long);
    });

    it('does not split a multi-byte character across a fold', () => {
      const ics = service.render([milestone({ name: 'é'.repeat(100) })], 'Cal');

      // A broken fold would leave a replacement character behind.
      expect(ics).not.toContain('�');
      const summary = logicalLines(ics).find((l) =>
        l.startsWith('SUMMARY:'),
      ) as string;
      expect(summary).toContain('é'.repeat(100));
    });
  });

  // -- Token handling ---------------------------------------------------------

  describe('subscription tokens', () => {
    it('round-trips a user id', () => {
      const token = service.issueToken('user-1');

      expect(service.verifyToken(token)).toBe('user-1');
    });

    it('issues a stable token for the same user', () => {
      expect(service.issueToken('user-1')).toBe(service.issueToken('user-1'));
    });

    it('issues different tokens for different users', () => {
      expect(service.issueToken('user-1')).not.toBe(service.issueToken('user-2'));
    });

    it('rejects a token whose user id was swapped for another', () => {
      const forged =
        Buffer.from('user-2').toString('base64url') +
        '.' +
        service.issueToken('user-1').split('.')[1];

      expect(() => service.verifyToken(forged)).toThrow(UnauthorizedException);
    });

    it('rejects a tampered signature', () => {
      const token = service.issueToken('user-1');
      const [id, sig] = token.split('.');
      const tampered = `${id}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;

      expect(() => service.verifyToken(tampered)).toThrow(UnauthorizedException);
    });

    it('rejects a malformed or empty token', () => {
      expect(() => service.verifyToken('')).toThrow(UnauthorizedException);
      expect(() => service.verifyToken('nodot')).toThrow(UnauthorizedException);
      expect(() => service.verifyToken('a.b.c')).toThrow(UnauthorizedException);
      expect(() => service.verifyToken(undefined as unknown as string)).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('when no feed secret is configured', () => {
    it('refuses to issue or verify tokens rather than signing with an empty key', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CalendarService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('') } },
        ],
      }).compile();
      const unconfigured = module.get<CalendarService>(CalendarService);

      expect(() => unconfigured.issueToken('user-1')).toThrow(UnauthorizedException);
      expect(() => unconfigured.verifyToken('a.b')).toThrow(UnauthorizedException);
    });
  });

  // -- Scoping ----------------------------------------------------------------

  describe('getUserMilestones', () => {
    it('only returns milestones from shipments the user participates in', async () => {
      prisma.user.findUnique.mockResolvedValue({ stellarAddress: 'GME' });

      await service.getUserMilestones('user-1');

      const where = prisma.milestone.findMany.mock.calls[0][0].where;
      expect(where.shipment.OR).toEqual([
        { buyerAddress: 'GME' },
        { supplierAddress: 'GME' },
        { logisticsAddress: 'GME' },
        { arbiterAddress: 'GME' },
      ]);
    });

    it('only considers milestones that actually have a due date', async () => {
      prisma.user.findUnique.mockResolvedValue({ stellarAddress: 'GME' });

      await service.getUserMilestones('user-1');

      const where = prisma.milestone.findMany.mock.calls[0][0].where;
      expect(where.dueAt).toEqual({ not: null });
    });

    it('returns nothing for an unknown user rather than every milestone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUserMilestones('ghost')).resolves.toEqual([]);
      expect(prisma.milestone.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getShipmentMilestones', () => {
    it('scopes to the shipment and orders by due date', async () => {
      await service.getShipmentMilestones('SHIP-1');

      const args = prisma.milestone.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ shipmentId: 'SHIP-1', dueAt: { not: null } });
      expect(args.orderBy).toEqual({ dueAt: 'asc' });
    });
  });
});
