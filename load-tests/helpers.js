/**
 * Shared k6 helpers and default thresholds for ChainSettle load tests.
 *
 * Env vars:
 *   BASE_URL   – API origin (default http://localhost:3000)
 *   JWT_TOKEN  – Bearer token for authenticated endpoints (optional for login suite)
 *   STELLAR_ADDRESS / SIGNED_NONCE / SIGNATURE – login credentials for auth flow
 */
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const API = `${BASE_URL}/api/v1`;

export const defaultThresholds = {
  http_req_failed: ['rate<0.05'],
  http_req_duration: ['p(95)<800', 'p(99)<2000'],
};

export function authHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function passFailSummary(data) {
  const failed = data.metrics.http_req_failed?.values?.rate ?? 0;
  const p95 = data.metrics.http_req_duration?.values['p(95)'] ?? 0;
  const p99 = data.metrics.http_req_duration?.values['p(99)'] ?? 0;
  const checks = data.metrics.checks?.values?.rate ?? 0;

  console.log('======== ChainSettle load-test summary ========');
  console.log(`checks pass rate : ${(checks * 100).toFixed(1)}%`);
  console.log(`http failure rate: ${(failed * 100).toFixed(2)}%`);
  console.log(`p95 latency      : ${p95.toFixed(1)} ms`);
  console.log(`p99 latency      : ${p99.toFixed(1)} ms`);
  console.log('==============================================');
}
