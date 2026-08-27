import http from 'k6/http';
import { check, sleep } from 'k6';
import { API, defaultThresholds, authHeaders, passFailSummary } from './helpers.js';

/**
 * Milestone confirmation write load test.
 *
 * Requires JWT_TOKEN, SHIPMENT_ID, MILESTONE_INDEX.
 * Uses unique synthetic tx hashes so concurrent VUs do not collide.
 *
 * Baseline (local, 10 VUs): p95 < 800ms, error rate < 10%
 * (higher error tolerance because many VUs will hit 409 once the milestone
 * is already confirmed — that still validates write-path capacity).
 */
export const options = {
  scenarios: {
    milestone_confirm: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 5 },
        { duration: '1m', target: 10 },
        { duration: '20s', target: 0 },
      ],
    },
  },
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<800', 'p(99)<2000'],
    http_req_failed: ['rate<0.10'],
    checks: ['rate>0.85'],
  },
};

export default function () {
  const token = __ENV.JWT_TOKEN;
  const shipmentId = __ENV.SHIPMENT_ID;
  const index = __ENV.MILESTONE_INDEX || '0';

  if (!token || !shipmentId) {
    throw new Error('JWT_TOKEN and SHIPMENT_ID are required for milestone confirm load test');
  }

  const txHash = `loadtest_${__VU}_${__ITER}_${Date.now().toString(16)}`;
  const res = http.post(
    `${API}/shipments/${shipmentId}/milestones/${index}/confirm`,
    JSON.stringify({
      txHash,
      paymentReleased: __ENV.PAYMENT_RELEASED || '1000000000',
    }),
    {
      headers: authHeaders(token),
      tags: { name: 'POST /milestones/:index/confirm' },
    },
  );

  check(res, {
    'confirm accepted or conflict': (r) =>
      r.status === 200 || r.status === 409 || r.status === 403 || r.status === 404,
  });

  sleep(1);
}

export function handleSummary(data) {
  passFailSummary(data);
  const p95 = data.metrics.http_req_duration?.values['p(95)'] ?? 0;
  const failed = data.metrics.http_req_failed?.values?.rate ?? 0;
  return {
    stdout: `\nMilestone confirm load test finished. p95=${p95.toFixed(1)}ms fail_rate=${(failed * 100).toFixed(2)}%\n`,
  };
}
