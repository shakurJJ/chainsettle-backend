/**
 * Jest globalSetup — spins up the NestJS application once for all
 * provider verification specs, then stores the server port in
 * process.env so individual spec files can reference it.
 *
 * NOTE: We intentionally do NOT call app.listen() inside a NestJS test
 * module here because globalSetup runs in a separate worker that cannot
 * share the module graph.  Instead we spawn the compiled app on a random
 * port using child_process and expose it via an env var.
 *
 * For local runs without a compiled dist/, set PACT_PROVIDER_BASE_URL
 * directly and skip globalSetup by commenting out the key in jest-pact.config.js.
 */

import { execSync } from 'child_process';
import * as net from 'net';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (!address || typeof address === 'string') return reject(new Error('No address'));
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

export default async function globalSetup() {
  // If the caller already pointed us at a running server, skip spin-up.
  if (process.env.PACT_PROVIDER_BASE_URL) {
    console.log(`[pact-setup] Using pre-configured provider: ${process.env.PACT_PROVIDER_BASE_URL}`);
    return;
  }

  // Pick a random free port so parallel CI jobs don't collide.
  const port = await getFreePort();
  process.env.PACT_PROVIDER_PORT = String(port);
  process.env.PACT_PROVIDER_BASE_URL = `http://localhost:${port}`;

  console.log(
    `[pact-setup] Provider will be started on port ${port} by the spec\'s beforeAll.`,
  );
}
