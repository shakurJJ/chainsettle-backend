# Observability

This document covers the three pillars of observability in the ChainSettle backend — metrics,
distributed tracing, and structured logging — and shows how to correlate a single request
across all three using its `X-Request-ID`.

---

## 1. Metrics (`/metrics`)

The backend exposes a Prometheus-compatible scrape endpoint at `/metrics` (no `/api/v1` prefix;
this path is excluded from the global prefix in `main.ts`).

### Custom metrics

Defined in `src/common/metrics/metrics.service.ts` and registered in
`src/common/metrics/metrics.module.ts`:

| Metric name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `chainsettle_events_processed_total` | Counter | `eventName` | On-chain events successfully processed by the poller |
| `chainsettle_events_failed_total` | Counter | — | On-chain events that failed processing |
| `chainsettle_shipments_created_total` | Counter | — | Shipments registered via the API |
| `chainsettle_active_shipments` | Gauge | — | Current count of ACTIVE shipments |
| `chainsettle_http_request_duration_seconds` | Histogram | `method`, `route`, `status` | Per-route HTTP latency (buckets: 5 ms → 5 s) |

### Default Node.js metrics

`PrometheusModule` is initialised with `defaultMetrics: { enabled: true }`, so all standard
`prom-client` process metrics (`process_cpu_seconds_total`, `nodejs_heap_size_used_bytes`,
event-loop lag, etc.) are also exposed at `/metrics`.

### Health and metrics paths are excluded from spans

`/health` and `/metrics` are suppressed in the OpenTelemetry HTTP instrumentation
(`ignoreIncomingRequestHook`) to keep traces clean. They are also excluded from the global
API prefix.

### Starter Grafana panels

| Panel | Query sketch |
|-------|-------------|
| Request rate (req/s) | `rate(chainsettle_http_request_duration_seconds_count[1m])` |
| p99 latency by route | `histogram_quantile(0.99, sum by (le, route) (rate(chainsettle_http_request_duration_seconds_bucket[5m])))` |
| Error rate (5xx) | `rate(chainsettle_http_request_duration_seconds_count{status=~"5.."}[1m])` |
| Events processed/s | `rate(chainsettle_events_processed_total[1m])` |
| Event failures | `increase(chainsettle_events_failed_total[5m])` |
| Active shipments | `chainsettle_active_shipments` |

---

## 2. Distributed tracing (OpenTelemetry)

Tracing is **opt-in**: the SDK is only initialised when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
When the variable is absent the application runs with zero tracing overhead.

### Environment variables

| Variable | Required for tracing | Description |
|----------|---------------------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes | Base URL of the OTLP/HTTP collector, e.g. `http://otel-collector:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | JSON object of extra headers, e.g. `{"x-honeycomb-team":"abc"}` |
| `OTEL_SERVICE_NAME` | No | Service name in traces (default: `chainsettle-backend`) |

### How it works

`initTracing()` is called at the very top of `src/main.ts`, before `NestFactory.create()`,
so that Node.js built-in module patches are applied before any `require()` inside NestJS or
Prisma. The SDK uses `OTLPTraceExporter` over HTTP/protobuf.

Auto-instrumented surfaces:

- **Inbound HTTP** — every NestJS route produces a root span with method, route, and status code.
- **Outbound HTTP/HTTPS** — axios calls (Stellar RPC, Pinata IPFS) produce child spans automatically.
- **Prisma** — database queries produce child spans when
  `@opentelemetry/instrumentation-prisma` is installed.

`TracingInterceptor` (`src/common/tracing/tracing.interceptor.ts`) enriches each inbound
span with:

- `http.route` — parameterised route path (e.g., `/api/v1/shipments/:id`)
- `http.request_id` / `chainsettle.request_id` — the `X-Request-ID` correlation value
- `enduser.id` — the authenticated user's Stellar address (omitted for unauthenticated routes)

For manual spans inside service methods use the `withSpan` helper
(`src/common/tracing/trace.helper.ts`):

```ts
import { withSpan } from '../../common/tracing/trace.helper';

async fetchContractEvents(startLedger: number) {
  return withSpan('stellar.fetchContractEvents', async (span) => {
    span.setAttribute('stellar.start_ledger', startLedger);
    const events = await this.rpcClient.getEvents({ startLedger });
    span.setAttribute('stellar.event_count', events.length);
    return events;
  });
}
```

### Pointing a local collector at the API

Example `docker-compose` snippet using Jaeger as an all-in-one backend:

```yaml
services:
  jaeger:
    image: jaegertracing/all-in-one:1.57
    ports:
      - "16686:16686"   # Jaeger UI
      - "4318:4318"     # OTLP/HTTP receiver
```

Then set in your `.env`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=chainsettle-backend
```

In `development` mode the SDK uses `SimpleSpanProcessor` (synchronous flush), so spans appear
in the Jaeger UI immediately.  In `production` it switches to `BatchSpanProcessor`.

---

## 3. Structured logging (Winston)

Logging is configured in `src/common/logger/winston.logger.ts` and injected into NestJS via
`WinstonModule.createLogger()` in `main.ts`.

### Log levels

| Environment | Default level | Override |
|-------------|---------------|---------|
| `development` | `debug` | `LOG_LEVEL` env var |
| `production` | `info` | `LOG_LEVEL` env var |

### Log format

**Production** — JSON lines on stdout (structured, easy to ingest into Elasticsearch, CloudWatch,
or Loki):

```json
{
  "level": "info",
  "message": "Shipment SHIP-001 created",
  "timestamp": "2026-08-28T19:00:00.123Z",
  "context": "ShipmentsService"
}
```

**Development** — pretty-printed NestJS-style output with colour and indentation.

Every log line written through NestJS's `Logger` or the Winston logger automatically includes
`timestamp` and the logger context (class name).

### Request ID in logs

`RequestIdMiddleware` (`src/common/middleware/request-id.middleware.ts`) runs before the JWT
guard on every request. It:

1. Reads `X-Request-ID` from the incoming request header, or generates a fresh UUID if absent.
2. Sets `X-Request-ID` on the response.
3. Stores the ID in `AsyncLocalStorage` (`requestIdStorage`).

Services and interceptors can retrieve the current request ID from `requestIdStorage.getStore()`
to include it in log lines, enabling full log-to-trace correlation without passing it through
every function parameter.

---

## 4. Correlating a single request across logs, traces, and metrics

Here is a worked example showing how one `POST /api/v1/shipments` request can be followed
end-to-end:

### Step 1 — the client sends a request ID

```
POST /api/v1/shipments HTTP/1.1
Authorization: Bearer eyJ...
X-Request-ID: 7f3c1a2b-84d4-4e0c-a1f7-b6d9e2c3f0a1
Content-Type: application/json
```

If the client omits the header, `RequestIdMiddleware` generates a UUID and the same flow
applies.

### Step 2 — the backend echoes it on the response

```
HTTP/1.1 201 Created
X-Request-ID: 7f3c1a2b-84d4-4e0c-a1f7-b6d9e2c3f0a1
```

### Step 3 — find the trace

In Jaeger (or any OTLP-compatible UI), search for spans with attribute:

```
http.request_id = 7f3c1a2b-84d4-4e0c-a1f7-b6d9e2c3f0a1
```

The root span is the `POST /api/v1/shipments` HTTP span. Child spans include the Prisma
`INSERT` query, any outgoing Stellar RPC calls, and IPFS pinning if triggered.

### Step 4 — find the logs

If you include the request ID in your log queries:

```
# Loki / Grafana LogQL
{service="chainsettle-backend"} |= "7f3c1a2b-84d4-4e0c-a1f7-b6d9e2c3f0a1"

# CloudWatch Logs Insights
fields @timestamp, @message
| filter @message like "7f3c1a2b-84d4-4e0c-a1f7-b6d9e2c3f0a1"
| sort @timestamp asc
```

### Step 5 — find the metrics

The `chainsettle_http_request_duration_seconds` histogram records the route
(`/api/v1/shipments`), method, and status for every request. Combine the timestamp from the
trace with a small time window in Prometheus/Grafana to see concurrent load and latency
percentiles at the moment the traced request ran.

---

## Implementation references

| Concern | Location |
|---------|----------|
| Prometheus metrics definitions | `src/common/metrics/metrics.service.ts` |
| Prometheus module registration | `src/common/metrics/metrics.module.ts` |
| HTTP request duration histogram | `src/common/interceptors/http-metrics.interceptor.ts` |
| OTel SDK bootstrap | `src/common/tracing/tracing.ts` |
| NestJS span enrichment interceptor | `src/common/tracing/tracing.interceptor.ts` |
| Manual span helper | `src/common/tracing/trace.helper.ts` |
| Winston logger factory | `src/common/logger/winston.logger.ts` |
| Request ID middleware | `src/common/middleware/request-id.middleware.ts` |
