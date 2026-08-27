import http from 'k6/http';
import { check, sleep } from 'k6';
import { API, defaultThresholds, authHeaders, passFailSummary } from './helpers.js';

/**
 * Paginated shipment list load test (read-heavy path / replica candidate).
 *
 * Requires JWT_TOKEN. Baseline (local, 30 VUs): p95 < 400ms, error rate < 2%.
 */
export const options = {
  scenarios: {
    shipment_list: {
      executor: 'constant-vus',
      vus: 30,
      duration: '2m',
    },
  },
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<400', 'p(99)<1000'],
    http_req_failed: ['rate<0.02'],
    checks: ['rate>0.95'],
  },
};

export default function () {
  const token = __ENV.JWT_TOKEN;
  if (!token) {
    throw new Error('JWT_TOKEN env var is required for shipment list load test');
  }

  const page = (__VU % 5) + 1;
  const res = http.get(`${API}/shipments?page=${page}&limit=20`, {
    headers: authHeaders(token),
    tags: { name: 'GET /shipments' },
  });

  check(res, {
    'shipments status 200': (r) => r.status === 200,
    'shipments has data array': (r) => {
      try {
        const body = r.json();
        const payload = body.data ?? body;
        return Array.isArray(payload?.data) || Array.isArray(payload);
      } catch {
        return false;
      }
    },
  });

  sleep(0.5);
}

export function handleSummary(data) {
  passFailSummary(data);
  const p95 = data.metrics.http_req_duration?.values['p(95)'] ?? 0;
  const failed = data.metrics.http_req_failed?.values?.rate ?? 0;
  return {
    stdout: `\nShipments list load test finished. p95=${p95.toFixed(1)}ms fail_rate=${(failed * 100).toFixed(2)}%\n`,
  };
}
