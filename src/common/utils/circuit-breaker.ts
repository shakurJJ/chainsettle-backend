export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing a trial call. */
  cooldownMs: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
  openedAt: string | null;
  /** When an OPEN breaker will next allow a trial call. */
  retryAt: string | null;
  lastError: string | null;
}

/** Thrown instead of calling the wrapped function while the breaker is open. */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit '${name}' is open — skipping call`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Minimal in-process circuit breaker (closed → open → half-open).
 *
 * - CLOSED: calls pass through; `failureThreshold` consecutive failures open it.
 * - OPEN: calls fail fast with CircuitOpenError until `cooldownMs` has elapsed.
 * - HALF_OPEN: a single trial call is let through; success closes the breaker,
 *   failure re-opens it for another cool-down. Concurrent calls during the
 *   trial fail fast.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();

    if (this.state === 'OPEN') {
      throw new CircuitOpenError(this.name);
    }

    const isTrial = this.state === 'HALF_OPEN';
    if (isTrial) {
      if (this.trialInFlight) throw new CircuitOpenError(this.name);
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }

  /** True while calls are being short-circuited (OPEN, cool-down not yet elapsed). */
  isOpen(): boolean {
    this.maybeHalfOpen();
    return this.state === 'OPEN';
  }

  getState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  getSnapshot(): CircuitBreakerSnapshot {
    const state = this.getState();
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.options.failureThreshold,
      cooldownMs: this.options.cooldownMs,
      openedAt: this.openedAt !== null ? new Date(this.openedAt).toISOString() : null,
      retryAt:
        state === 'OPEN' && this.openedAt !== null
          ? new Date(this.openedAt + this.options.cooldownMs).toISOString()
          : null,
      lastError: this.lastError,
    };
  }

  private maybeHalfOpen(): void {
    if (
      this.state === 'OPEN' &&
      this.openedAt !== null &&
      this.now() - this.openedAt >= this.options.cooldownMs
    ) {
      this.state = 'HALF_OPEN';
    }
  }

  private onSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }
}
