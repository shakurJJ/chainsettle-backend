import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

/**
 * Minimal cache contract. Implementations backed by Redis should throw when
 * the backing store is unavailable so the interceptor can degrade gracefully.
 */
export interface ResponseCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

/**
 * Records whether the response cache is currently operating in fallback mode
 * (i.e. Redis is unavailable and caching is bypassed).
 */
export interface FallbackMetrics {
  setCacheFallback(active: boolean): void;
}

@Injectable()
export class ResponseCacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseCacheInterceptor.name);
  private fallbackActive = false;

  constructor(
    private readonly store: ResponseCacheStore,
    private readonly metrics?: FallbackMetrics,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest();
    const key = this.cacheKey(request);

    if (!key) {
      return next.handle();
    }

    try {
      const cached = await this.store.get(key);
      this.markHealthy();
      if (cached !== null && cached !== undefined) {
        return of(JSON.parse(cached));
      }
    } catch (error) {
      // Redis is unavailable: bypass the cache and serve the request normally.
      this.markFallback(error);
      return next.handle();
    }

    return next.handle().pipe(
      tap((body) => {
        void this.store
          .set(key, JSON.stringify(body))
          .then(() => this.markHealthy())
          .catch((error) => this.markFallback(error));
      }),
      catchError((error) => throwError(() => error)),
    );
  }

  private cacheKey(request: any): string | null {
    if (!request || request.method !== 'GET') {
      return null;
    }
    return `response-cache:${request.originalUrl ?? request.url}`;
  }

  private markFallback(error: unknown): void {
    if (!this.fallbackActive) {
      this.fallbackActive = true;
      this.metrics?.setCacheFallback(true);
      this.logger.warn(
        `Response cache unavailable, bypassing cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private markHealthy(): void {
    if (this.fallbackActive) {
      this.fallbackActive = false;
      this.metrics?.setCacheFallback(false);
      this.logger.log('Response cache recovered, resuming caching');
    }
  }
}
