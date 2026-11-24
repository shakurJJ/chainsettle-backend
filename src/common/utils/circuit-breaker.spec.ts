import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let clock: number;
  let breaker: CircuitBreaker;
  const fail = () => Promise.reject(new Error('provider down'));
  const ok = () => Promise.resolve('ok');

  beforeEach(() => {
    clock = 1_000_000;
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      cooldownMs: 60_000,
      now: () => clock,
    });
  });

  it('stays closed below the failure threshold', async () => {
    await expect(breaker.exec(fail)).rejects.toThrow('provider down');
    await expect(breaker.exec(fail)).rejects.toThrow('provider down');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('opens after repeated failures and short-circuits further calls', async () => {
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.getState()).toBe('OPEN');

    const fn = jest.fn(ok);
    await expect(breaker.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
    expect(breaker.getSnapshot()).toMatchObject({
      state: 'OPEN',
      consecutiveFailures: 3,
      lastError: 'provider down',
      retryAt: new Date(clock + 60_000).toISOString(),
    });
  });

  it('a success resets the consecutive failure count', async () => {
    await expect(breaker.exec(fail)).rejects.toThrow();
    await expect(breaker.exec(fail)).rejects.toThrow();
    await breaker.exec(ok);
    await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('half-opens after the cool-down and closes again on a successful trial', async () => {
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toThrow();

    clock += 60_000;
    expect(breaker.getState()).toBe('HALF_OPEN');

    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getSnapshot().consecutiveFailures).toBe(0);
  });

  it('re-opens for another cool-down when the half-open trial fails', async () => {
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toThrow();

    clock += 60_000;
    await expect(breaker.exec(fail)).rejects.toThrow('provider down');
    expect(breaker.getState()).toBe('OPEN');

    clock += 30_000;
    expect(breaker.getState()).toBe('OPEN');
    clock += 30_000;
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('lets only one trial call through while half-open', async () => {
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toThrow();
    clock += 60_000;

    let resolveTrial!: (v: string) => void;
    const trial = breaker.exec(() => new Promise<string>((r) => (resolveTrial = r)));
    await expect(breaker.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    resolveTrial('ok');
    await expect(trial).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });
});
