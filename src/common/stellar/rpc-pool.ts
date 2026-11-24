import { Logger } from '@nestjs/common';

export interface EndpointHealth {
  url: string;
  healthy: boolean;
  active: boolean;
  latencyMs: number | null;
  latestLedger: number | null;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  lastError: string | null;
}

interface Endpoint<T> {
  url: string;
  client: T;
  healthy: boolean;
  latencyMs: number | null;
  latestLedger: number | null;
  failures: number;
  openUntil: number;
  lastError: string | null;
}

export interface RpcPoolOptions<T> {
  name: string;
  /** Probe returning the latest ledger; must throw when the endpoint is unhealthy. */
  probe: (client: T, url: string) => Promise<number>;
  failureThreshold?: number;
  cooldownMs?: number;
}

/** Network/5xx errors trigger failover; 4xx-style application errors do not. */
export function isFailoverError(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  if (typeof status === 'number') return status >= 500 || status === 429;
  const code = err?.code ?? '';
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code) ||
    /network|timeout|socket hang up/i.test(err?.message ?? '')
  );
}

/**
 * Pool of RPC/Horizon clients with per-endpoint circuit breakers.
 * `proxy` behaves like a single client: each method call goes to the healthiest
 * endpoint and fails over to the next one on network/5xx errors.
 */
export class RpcPool<T extends object> {
  private readonly logger: Logger;
  private readonly endpoints: Endpoint<T>[];
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  readonly proxy: T;

  constructor(urls: string[], factory: (url: string) => T, private readonly opts: RpcPoolOptions<T>) {
    this.logger = new Logger(`RpcPool:${opts.name}`);
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.endpoints = urls.map((url) => ({
      url,
      client: factory(url),
      healthy: true,
      latencyMs: null,
      latestLedger: null,
      failures: 0,
      openUntil: 0,
      lastError: null,
    }));
    this.proxy = this.buildProxy();
  }

  get activeUrl(): string {
    return this.ranked()[0].url;
  }

  /** Probe every endpoint; updates health, latency and latest ledger. */
  async healthCheck(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (ep) => {
        const started = Date.now();
        try {
          ep.latestLedger = await this.opts.probe(ep.client, ep.url);
          ep.latencyMs = Date.now() - started;
          ep.healthy = true;
          ep.failures = 0;
          ep.openUntil = 0;
          ep.lastError = null;
        } catch (err: any) {
          ep.healthy = false;
          ep.latencyMs = null;
          ep.lastError = err?.message ?? String(err);
          ep.openUntil = Date.now() + this.cooldownMs;
        }
      }),
    );
  }

  status(): EndpointHealth[] {
    const active = this.activeUrl;
    return this.endpoints.map((ep) => ({
      url: ep.url,
      healthy: ep.healthy && !this.isOpen(ep),
      active: ep.url === active,
      latencyMs: ep.latencyMs,
      latestLedger: ep.latestLedger,
      consecutiveFailures: ep.failures,
      circuitOpenUntil: this.isOpen(ep) ? new Date(ep.openUntil).toISOString() : null,
      lastError: ep.lastError,
    }));
  }

  private isOpen(ep: Endpoint<T>): boolean {
    return ep.openUntil > Date.now();
  }

  /** Healthy endpoints first (highest ledger, then lowest latency), then the rest in config order. */
  private ranked(): Endpoint<T>[] {
    const up = this.endpoints.filter((ep) => ep.healthy && !this.isOpen(ep));
    const down = this.endpoints.filter((ep) => !up.includes(ep));
    up.sort(
      (a, b) =>
        (b.latestLedger ?? 0) - (a.latestLedger ?? 0) ||
        (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
    );
    return [...up, ...down];
  }

  private recordFailure(ep: Endpoint<T>, err: any) {
    ep.failures += 1;
    ep.lastError = err?.message ?? String(err);
    if (ep.failures >= this.failureThreshold) {
      ep.healthy = false;
      ep.openUntil = Date.now() + this.cooldownMs;
      this.logger.warn(`Circuit opened for ${ep.url}: ${ep.lastError}`);
    }
  }

  private buildProxy(): T {
    const first = this.endpoints[0].client;
    return new Proxy(first, {
      get: (_target, prop) => {
        const value = (first as any)[prop];
        if (typeof value !== 'function') return (this.ranked()[0].client as any)[prop];
        return async (...args: any[]) => {
          let lastErr: any;
          for (const ep of this.ranked()) {
            try {
              const result = await (ep.client as any)[prop](...args);
              ep.failures = 0;
              return result;
            } catch (err) {
              if (!isFailoverError(err)) throw err;
              lastErr = err;
              this.recordFailure(ep, err);
              this.logger.warn(`${String(prop)} failed on ${ep.url}, failing over`);
            }
          }
          throw lastErr;
        };
      },
    });
  }
}

/** Parse `STELLAR_*_URLS` (comma-separated) falling back to the single-URL var. */
export function parseUrlList(list?: string, single?: string): string[] {
  const urls = (list ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length) return urls;
  return single ? [single] : [];
}
