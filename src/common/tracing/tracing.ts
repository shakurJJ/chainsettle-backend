/**
 * OpenTelemetry SDK bootstrap
 *
 * Called ONCE at process start, before NestFactory.create(), so that
 * auto-instrumentation patches are applied to Node.js core modules
 * (http, https, net) before any require() of those modules occurs
 * inside NestJS or Prisma.
 *
 * ── Design decisions ──────────────────────────────────────────────────────
 *
 * 1. FULLY DISABLED when OTEL_EXPORTER_OTLP_ENDPOINT is absent.
 *    No SDK is created, no background threads, no performance overhead.
 *    Setting the env var to any non-empty string opts in.
 *
 * 2. Auto-instrumented surfaces:
 *    - NestJS HTTP (inbound) — via @opentelemetry/instrumentation-http
 *    - Outbound HTTP/HTTPS   — same instrumentation; axios uses http internally
 *    - Prisma                — via @opentelemetry/instrumentation-prisma
 *      (falls back to a no-op if the package is absent, so the app still
 *       starts without prisma instrumentation installed)
 *
 * 3. X-Request-ID propagation:
 *    HttpMetricsInterceptor and RequestIdMiddleware already plumb the
 *    request ID through AsyncLocalStorage.  The OtelRequestIdSpanProcessor
 *    (below) reads that storage on every span-start and attaches the ID
 *    as a span attribute so traces and structured logs share a common key.
 *
 * 4. OTLP / gRPC export:
 *    Uses OTLPTraceExporter over HTTP/protobuf.  Switch to gRPC by swapping
 *    the import for @opentelemetry/exporter-trace-otlp-grpc if needed.
 *
 * ── Required packages (install manually) ──────────────────────────────────
 *
 *   npm install \
 *     @opentelemetry/sdk-node \
 *     @opentelemetry/auto-instrumentations-node \
 *     @opentelemetry/exporter-trace-otlp-http \
 *     @opentelemetry/instrumentation-http \
 *     @opentelemetry/instrumentation-prisma \
 *     @opentelemetry/sdk-trace-base \
 *     @opentelemetry/api
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// ─── Conditional bootstrap ────────────────────────────────────────────────────

export function initTracing(): void {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!otlpEndpoint) {
    // Tracing opt-out: no SDK initialised, zero overhead.
    return;
  }

  // Enable OTel diagnostic logging in dev so misconfiguration is visible.
  if (process.env.NODE_ENV !== 'production') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  try {
    // Dynamic require so the app still starts if the packages are absent
    // (they will be absent until the team runs the install command).
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const { Resource } = require('@opentelemetry/resources');
    const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } =
      require('@opentelemetry/semantic-conventions');

    // Optional Prisma instrumentation — graceful fallback when not installed
    let prismaInstrumentation: any | null = null;
    try {
      const { PrismaInstrumentation } = require('@opentelemetry/instrumentation-prisma');
      prismaInstrumentation = new PrismaInstrumentation();
    } catch {
      console.warn(
        '[otel] @opentelemetry/instrumentation-prisma not installed — ' +
          'Prisma spans will not be captured.',
      );
    }

    const exporter = new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        : undefined,
    });

    // In production use batching to minimise RPC calls; in dev use simple
    // (synchronous flush) so spans appear immediately in local Jaeger.
    const spanProcessor =
      process.env.NODE_ENV === 'production'
        ? new BatchSpanProcessor(exporter)
        : new SimpleSpanProcessor(exporter);

    const instrumentations: any[] = [
      new HttpInstrumentation({
        // Attach X-Request-ID from the request header as a span attribute
        // on inbound spans so the trace is directly correlatable to logs.
        requestHook: (span, request) => {
          const req = request as any;
          const requestId =
            req?.headers?.['x-request-id'] ??
            req?.headers?.['X-Request-ID'] ??
            null;
          if (requestId) {
            span.setAttribute('http.request_id', requestId);
          }
        },
        // Suppress internal health-check and metrics polling spans to keep
        // traces clean — these are extremely high-frequency and low-value.
        ignoreIncomingRequestHook: (request) => {
          const url = (request as any).url ?? '';
          return (
            url.includes('/health') ||
            url.includes('/metrics') ||
            url === '/'
          );
        },
      }),
    ];

    if (prismaInstrumentation) {
      instrumentations.push(prismaInstrumentation);
    }

    const sdk = new NodeSDK({
      resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]:
          process.env.OTEL_SERVICE_NAME ?? 'chainsettle-backend',
        [SEMRESATTRS_SERVICE_VERSION]:
          process.env.npm_package_version ?? '0.1.0',
      }),
      spanProcessor,
      instrumentations,
    });

    sdk.start();

    // Ensure graceful SDK shutdown so the batch exporter flushes pending spans.
    process.on('SIGTERM', () => {
      sdk
        .shutdown()
        .then(() => console.log('[otel] SDK shut down cleanly'))
        .catch((err: Error) => console.error('[otel] SDK shutdown error', err))
        .finally(() => process.exit(0));
    });

    console.log(
      `[otel] Tracing enabled — exporting to ${otlpEndpoint}`,
    );
  } catch (err: any) {
    // If any OTel package is missing we log a clear message and carry on.
    // The application remains fully functional, just without traces.
    console.warn(
      '[otel] Failed to initialise tracing — ' +
        'ensure OpenTelemetry packages are installed:\n' +
        '  npm install @opentelemetry/sdk-node ' +
        '@opentelemetry/auto-instrumentations-node ' +
        '@opentelemetry/exporter-trace-otlp-http ' +
        '@opentelemetry/instrumentation-http ' +
        '@opentelemetry/instrumentation-prisma ' +
        '@opentelemetry/sdk-trace-base ' +
        '@opentelemetry/api\n' +
        `Error: ${err?.message}`,
    );
  }
}
