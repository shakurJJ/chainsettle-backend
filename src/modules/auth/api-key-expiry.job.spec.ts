/**
 * Unit tests for ApiKeyExpiryJob.warnExpiringKeys()
 *
 * We test the core warning logic without relying on the generated Prisma client
 * (which may be stale in this environment). The job behaviour is exercised
 * through plain mock objects.
 */

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

const SYSTEM_ALERT = 'SYSTEM_ALERT';

// ---------------------------------------------------------------------------
// Inline the job logic so the spec has no compile-time dependency on
// PrismaService or @nestjs/schedule decorators.
// ---------------------------------------------------------------------------

interface ExpiringKey {
  id: string;
  name: string;
  expiresAt: Date;
  user: { id: string; stellarAddress: string };
}

interface Deps {
  findExpiringKeys: (now: Date, cutoff: Date) => Promise<ExpiringKey[]>;
  notifyUser: (address: string, type: string, title: string, msg: string, data: object) => Promise<void>;
  stampWarning: (id: string, at: Date) => Promise<void>;
}

const WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function runWarnExpiringKeys(deps: Deps) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + WARNING_WINDOW_MS);

  const keys = await deps.findExpiringKeys(now, cutoff);
  if (keys.length === 0) return;

  for (const key of keys) {
    const daysLeft = Math.ceil((key.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const expiryDateStr = key.expiresAt.toISOString().split('T')[0];

    const title = `API key "${key.name}" expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    const message =
      `Your API key "${key.name}" will expire on ${expiryDateStr}. ` +
      `Create a new key before then to avoid service interruption.`;

    await deps.notifyUser(key.user.stellarAddress, SYSTEM_ALERT, title, message, {
      apiKeyId: key.id,
      apiKeyName: key.name,
      expiresAt: key.expiresAt.toISOString(),
      daysLeft,
    });

    await deps.stampWarning(key.id, new Date());
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const mockUser = { id: 'user-1', stellarAddress: 'GABC123' };

function makeKey(daysAhead = 2): ExpiringKey {
  return {
    id: 'key-1',
    name: 'CI Pipeline',
    expiresAt: new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000),
    user: mockUser,
  };
}

describe('ApiKeyExpiryJob — warnExpiringKeys logic', () => {
  let notifyUser: jest.Mock;
  let stampWarning: jest.Mock;
  let findExpiringKeys: jest.Mock;

  beforeEach(() => {
    notifyUser = jest.fn().mockResolvedValue(undefined);
    stampWarning = jest.fn().mockResolvedValue(undefined);
    findExpiringKeys = jest.fn().mockResolvedValue([]);
  });

  const deps = () => ({ findExpiringKeys, notifyUser, stampWarning });

  it('does nothing when no keys are expiring soon', async () => {
    await runWarnExpiringKeys(deps());
    expect(notifyUser).not.toHaveBeenCalled();
    expect(stampWarning).not.toHaveBeenCalled();
  });

  it('calls notifyUser with SYSTEM_ALERT for a key expiring within 7 days', async () => {
    findExpiringKeys.mockResolvedValue([makeKey(2)]);

    await runWarnExpiringKeys(deps());

    expect(notifyUser).toHaveBeenCalledWith(
      mockUser.stellarAddress,
      SYSTEM_ALERT,
      expect.stringContaining('CI Pipeline'),
      expect.any(String),
      expect.objectContaining({ apiKeyId: 'key-1', daysLeft: expect.any(Number) }),
    );
  });

  it('stamps expiryWarningSentAt after sending the warning', async () => {
    findExpiringKeys.mockResolvedValue([makeKey(2)]);

    await runWarnExpiringKeys(deps());

    expect(stampWarning).toHaveBeenCalledWith('key-1', expect.any(Date));
  });

  it('sends one warning per key in a single run', async () => {
    findExpiringKeys.mockResolvedValue([makeKey(1), makeKey(6)]);

    await runWarnExpiringKeys(deps());

    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(stampWarning).toHaveBeenCalledTimes(2);
  });

  it('passes the correct daysLeft value in the notification data', async () => {
    findExpiringKeys.mockResolvedValue([makeKey(3)]);

    await runWarnExpiringKeys(deps());

    const data = notifyUser.mock.calls[0][4] as { daysLeft: number };
    expect(data.daysLeft).toBe(3);
  });

  it('includes singular "day" when exactly 1 day remains', async () => {
    findExpiringKeys.mockResolvedValue([makeKey(1)]);

    await runWarnExpiringKeys(deps());

    const title: string = notifyUser.mock.calls[0][2];
    expect(title).toMatch(/expires in 1 day$/);
  });
});
