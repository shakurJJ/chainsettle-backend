/**
 * trace.helper.ts
 *
 * Lightweight wrapper around the OpenTelemetry API for manual span creation
 * inside service methods.  When tracing is disabled the OTel API returns a
 * no-op tracer, so every call here is a zero-cost pass-through.
 *
 * Usage example (StellarService):
 *
 *   import { withSpan } from '../tracing/trace.helper';
 *
 *   async fetchContractEvents(startLedger: number) {
 *     return withSpan('stellar.fetchContractEvents', async (span) => {
 *       span.setAttribute('stellar.start_ledger', startLedger);
 *       const events = await this.rpcClient.getEvents({ startLedger, ... });
 *       span.setAttribute('stellar.event_count', events.length);
 *       return events;
 *     });
 *   }
 */

import { trace, context, SpanKind, SpanStatusCode, Attributes, Span } from '@opentelemetry/api';

const TRACER_NAME = 'chainsettle-backend';

/**
 * Runs `fn` inside a new child span named `spanName`.
 * Automatically records exceptions and sets the span status on error.
 *
 * @param spanName  - Dot-separated name, e.g. "stellar.fetchContractEvents"
 * @param fn        - Async function receiving the active span
 * @param attrs     - Optional initial attributes to set on the span
 * @param kind      - SpanKind (defaults to INTERNAL; use CLIENT for outbound calls)
 */
export async function withSpan<T>(
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Attributes,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);

  return tracer.startActiveSpan(
    spanName,
    { kind, attributes: attrs },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err: any) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Returns the current trace ID and span ID from the active span, or null
 * values when tracing is disabled.  Useful for injecting trace IDs into
 * structured log lines for cross-correlation.
 */
export function getCurrentTraceContext(): { traceId: string | null; spanId: string | null } {
  const span = trace.getActiveSpan();
  if (!span) return { traceId: null, spanId: null };

  const ctx = span.spanContext();
  if (!ctx || ctx.traceId === '00000000000000000000000000000000') {
    return { traceId: null, spanId: null };
  }

  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
