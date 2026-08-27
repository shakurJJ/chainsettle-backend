import http from 'k6/http';
import { check, sleep } from 'k6';
import { API, defaultThresholds, authHeaders, passFailSummary } from './helpers.js';

/**
 * Auth login flow load test.
 *
 * Exercises GET /auth/nonce then POST /auth/login under concurrent VUs.
 * Provide STELLAR_ADDRESS, SIGNED_NONCE, and SIGNATURE for a full login
 * path; without them the suite still load-tests nonce generation.
 *
 * Baseline (local, 20 VUs): nonce p95 < 300ms, login p95 < 500ms.
 */
export const options = {
  scenarios: {
    auth_login: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<500', 'p(99)<1200'],
    checks: ['rate>0.95'],
  },
};

export default function () {
  const address = __ENV.STELLAR_ADDRESS || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  const nonceRes = http.get(`${API}/auth/nonce?address=${address}`, {
    headers: authHeaders(),
    tags: { name: 'GET /auth/nonce' },
  });

  check(nonceRes, {
    'nonce status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  if (__ENV.SIGNED_NONCE && __ENV.SIGNATURE && __ENV.STELLAR_ADDRESS) {
    const loginRes = http.post(
      `${API}/auth/login`,
      JSON.stringify({
        stellarAddress: __ENV.STELLAR_ADDRESS,
        signedNonce: __ENV.SIGNED_NONCE,
        signature: __ENV.SIGNATURE,
      }),
      {
        headers: authHeaders(),
        tags: { name: 'POST /auth/login' },
      },
    );

    check(loginRes, {
      'login status is 200 or 401': (r) => r.status === 200 || r.status === 401,
    });
  }

  sleep(1);
}

export function handleSummary(data) {
  passFailSummary(data);
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, opts) {
  // Minimal inline summary so the script runs without k6/x/summary import quirks
  const p95 = data.metrics.http_req_duration?.values['p(95)'] ?? 0;
  const failed = data.metrics.http_req_failed?.values?.rate ?? 0;
  const passed = Object.values(data.root_group?.checks || {}).every
    ? ''
    : '';
  return `\nAuth load test finished. p95=${p95.toFixed(1)}ms fail_rate=${(failed * 100).toFixed(2)}%${passed}\n`;
}
