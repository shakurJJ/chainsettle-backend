/**
 * TracingInterceptor
 *
 * A NestJS interceptor that runs on every HTTP request and enriches the
 * active OpenTelemetry span with attributes that are already available
 * inside the NestJS context but not visible to the lower-level HTTP
 * instrumentation hook (route name, authenticated user identity, etc.).
 *
 * When tracing is disabled (no OTEL_EXPORTER_OTLP_ENDPOINT configured)
 * the OTel API returns a no-op tracer, so `trace.getActiveSpan()` returns
 * `undefined` and this interceptor is a zero-cost pass-through.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { requestIdStorage } from '../middleware/request-id.middleware';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const span = trace.getActiveSpan();

    if (span) {
      const req = context.switchToHttp().getRequest();

      // ── Route name ────────────────────────────────────────────────────
      // NestJS populates req.route.path after routing, which gives a clean
      // parameterised path like /api/v1/shipments/:id instead of the raw URL.
      const route: string = req.route?.path ?? req.path ?? 'unknown';
      span.updateName(`${req.method} ${route}`);
      span.setAttribute('http.route', route);

      // ── X-Request-ID correlation ──────────────────────────────────────
      // Read from AsyncLocalStorage set by RequestIdMiddleware — this is
      // the same value attached to every Winston log line, so traces and
      // logs are directly correlatable by request ID.
      const requestId = requestIdStorage.getStore() ?? req.headers?.['x-request-id'];
      if (requestId) {
        span.setAttribute('http.request_id', requestId);
        span.setAttribute('chainsettle.request_id', requestId);
      }

      // ── Authenticated user ────────────────────────────────────────────
      // JWT guard populates req.user after authentication. We expose the
      // Stellar address (not the internal UUID) to keep traces useful for
      // ops without exposing internal identifiers.
      if (req.user?.stellarAddress) {
        span.setAttribute('enduser.id', req.user.stellarAddress);
      }
    }

    return next.handle().pipe(
      tap({
        next: () => {
          if (span) {
            const res = context.switchToHttp().getResponse();
            span.setAttribute('http.status_code', res.statusCode);
            span.setStatus({ code: SpanStatusCode.OK });
          }
        },
        error: (err) => {
          if (span) {
            const status: number = err?.status ?? err?.statusCode ?? 500;
            span.setAttribute('http.status_code', status);
            span.setAttribute('error.type', err?.constructor?.name ?? 'Error');
            span.setAttribute('error.message', err?.message ?? 'Unknown error');
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err?.message,
            });
          }
        },
      }),
    );
  }
}
