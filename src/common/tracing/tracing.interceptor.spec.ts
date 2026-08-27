/**
 * TracingInterceptor unit tests
 *
 * Verifies that span attributes are set correctly for both successful
 * responses and errors, and that the interceptor is a safe no-op when
 * there is no active span (i.e. when tracing is disabled).
 */

import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { SpanStatusCode } from '@opentelemetry/api';
import { TracingInterceptor } from './tracing.interceptor';

// ─── Span mock ────────────────────────────────────────────────────────────────

function makeSpanMock() {
  return {
    updateName: jest.fn(),
    setAttribute: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
  };
}

// ─── OTel API mock ────────────────────────────────────────────────────────────

jest.mock('@opentelemetry/api', () => {
  const spanMock = {
    updateName: jest.fn(),
    setAttribute: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
  };

  return {
    trace: {
      getActiveSpan: jest.fn().mockReturnValue(spanMock),
    },
    SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
    // expose spanMock so tests can inspect it
    __spanMock: spanMock,
  };
});

// ─── request-id middleware mock ───────────────────────────────────────────────

jest.mock('../middleware/request-id.middleware', () => ({
  requestIdStorage: {
    getStore: jest.fn().mockReturnValue('test-request-id-123'),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<{
  method: string;
  path: string;
  route: { path: string };
  headers: Record<string, string>;
  user: { stellarAddress: string };
  statusCode: number;
}> = {}): ExecutionContext {
  const req = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/api/v1/shipments',
    route: overrides.route ?? { path: '/api/v1/shipments' },
    headers: overrides.headers ?? {},
    user: overrides.user,
  };

  const res = { statusCode: overrides.statusCode ?? 200 };

  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
}

function makeHandler(returnValue: any, throws = false): CallHandler {
  return {
    handle: () => throws ? throwError(() => returnValue) : of(returnValue),
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('TracingInterceptor', () => {
  let interceptor: TracingInterceptor;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let spanMock: ReturnType<typeof makeSpanMock>;

  beforeEach(() => {
    interceptor = new TracingInterceptor();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    spanMock = (require('@opentelemetry/api') as any).__spanMock;
    jest.clearAllMocks();
    // Re-enable span by default
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('@opentelemetry/api').trace.getActiveSpan as jest.Mock).mockReturnValue(spanMock);
  });

  it('is defined', () => {
    expect(interceptor).toBeDefined();
  });

  describe('when a span is active', () => {
    it('updates span name with method + route', (done) => {
      const ctx = makeContext({ method: 'GET', route: { path: '/api/v1/shipments' } });

      interceptor.intercept(ctx, makeHandler({ data: [] })).subscribe({
        complete: () => {
          expect(spanMock.updateName).toHaveBeenCalledWith('GET /api/v1/shipments');
          expect(spanMock.setAttribute).toHaveBeenCalledWith('http.route', '/api/v1/shipments');
          done();
        },
      });
    });

    it('sets http.request_id from AsyncLocalStorage', (done) => {
      const ctx = makeContext();

      interceptor.intercept(ctx, makeHandler({})).subscribe({
        complete: () => {
          expect(spanMock.setAttribute).toHaveBeenCalledWith(
            'http.request_id',
            'test-request-id-123',
          );
          expect(spanMock.setAttribute).toHaveBeenCalledWith(
            'chainsettle.request_id',
            'test-request-id-123',
          );
          done();
        },
      });
    });

    it('sets enduser.id from authenticated user Stellar address', (done) => {
      const ctx = makeContext({ user: { stellarAddress: 'GABC123' } });

      interceptor.intercept(ctx, makeHandler({})).subscribe({
        complete: () => {
          expect(spanMock.setAttribute).toHaveBeenCalledWith('enduser.id', 'GABC123');
          done();
        },
      });
    });

    it('sets status OK and http.status_code on success', (done) => {
      const ctx = makeContext({ statusCode: 200 });

      interceptor.intercept(ctx, makeHandler({})).subscribe({
        complete: () => {
          expect(spanMock.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
          expect(spanMock.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
          done();
        },
      });
    });

    it('sets status ERROR and error attributes on thrown error', (done) => {
      const ctx = makeContext();
      const err = Object.assign(new Error('Not Found'), { status: 404 });

      interceptor.intercept(ctx, makeHandler(err, true)).subscribe({
        error: () => {
          expect(spanMock.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
          expect(spanMock.setAttribute).toHaveBeenCalledWith('error.message', 'Not Found');
          expect(spanMock.setStatus).toHaveBeenCalledWith({
            code: SpanStatusCode.ERROR,
            message: 'Not Found',
          });
          done();
        },
      });
    });
  });

  describe('when no span is active (tracing disabled)', () => {
    it('passes the response through without throwing', (done) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('@opentelemetry/api').trace.getActiveSpan as jest.Mock).mockReturnValue(undefined);

      const ctx = makeContext();

      interceptor.intercept(ctx, makeHandler({ ok: true })).subscribe({
        next: (val) => {
          expect(val).toEqual({ ok: true });
        },
        complete: () => {
          expect(spanMock.updateName).not.toHaveBeenCalled();
          done();
        },
      });
    });

    it('propagates errors without throwing from the interceptor', (done) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('@opentelemetry/api').trace.getActiveSpan as jest.Mock).mockReturnValue(undefined);

      const ctx = makeContext();
      const err = new Error('upstream error');

      interceptor.intercept(ctx, makeHandler(err, true)).subscribe({
        error: (e) => {
          expect(e.message).toBe('upstream error');
          done();
        },
      });
    });
  });
});
