/**
 * Lightweight mock Soroban JSON-RPC + Horizon stub for local frontend development.
 *
 * DEV ONLY — not a substitute for testnet/mainnet integration testing.
 * - No real signature verification
 * - No real event emission or ledger progression beyond a static counter
 * - simulateTransaction returns canned success envelopes (not real XDR)
 *
 * Usage:
 *   npm run dev:mock-chain
 *   # then point .env at:
 *   #   STELLAR_RPC_URL=http://127.0.0.1:8787
 *   #   STELLAR_HORIZON_URL=http://127.0.0.1:8788
 */

import * as http from 'http';
import { URL } from 'url';

const RPC_PORT = Number(process.env.STELLAR_MOCK_RPC_PORT || 8787);
const HORIZON_PORT = Number(process.env.STELLAR_MOCK_HORIZON_PORT || 8788);

let latestLedger = 1_000_000;

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleRpc(method: string, params: any, id: unknown) {
  switch (method) {
    case 'getHealth':
      return { jsonrpc: '2.0', id, result: { status: 'healthy' } };

    case 'getLatestLedger':
      latestLedger += 1;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          id: 'mock-ledger',
          protocolVersion: 21,
          sequence: latestLedger,
        },
      };

    case 'getEvents':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          events: [],
          latestLedger,
          cursor: String(params?.startLedger ?? latestLedger),
        },
      };

    case 'getLedger':
    case 'getLedgers':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          ledgers: [
            {
              hash: '0'.repeat(64),
              sequence: params?.startLedger ?? latestLedger,
              ledgerCloseTime: Math.floor(Date.now() / 1000).toString(),
            },
          ],
          latestLedger,
        },
      };

    case 'getAccount':
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Account not found (mock)' },
      };

    case 'simulateTransaction':
      // Canned envelope — sync/reconcile paths should tolerate this without live chain.
      return {
        jsonrpc: '2.0',
        id,
        result: {
          transactionData: '',
          minResourceFee: '100',
          cost: { cpuInsns: '0', memBytes: '0' },
          results: [{ auth: [], xdr: 'AAAAAA==' }],
          latestLedger,
          events: [],
        },
      };

    case 'getLedgerEntries':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          entries: [],
          latestLedger,
        },
      };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found (mock): ${method}` },
      };
  }
}

const rpcServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { status: 'ok', service: 'mock-soroban-rpc' });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method Not Allowed' });
  }

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = handleRpc(body.method, body.params, body.id);
      json(res, 200, response);
    } catch (err: any) {
      json(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err?.message || 'Parse error' },
      });
    }
  });
});

const horizonServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${HORIZON_PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return json(res, 200, {
      horizon_version: 'mock',
      core_version: 'mock',
      network_passphrase: 'Test SDF Network ; September 2015',
    });
  }

  const accountMatch = url.pathname.match(/^\/accounts\/([A-Z0-9]+)$/);
  if (req.method === 'GET' && accountMatch) {
    const address = accountMatch[1];
    return json(res, 200, {
      id: address,
      account_id: address,
      sequence: '1',
      balances: [{ asset_type: 'native', balance: '10000.0000000' }],
      signers: [{ key: address, weight: 1, type: 'ed25519_public_key' }],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false },
    });
  }

  json(res, 404, { type: 'https://stellar.org/horizon-errors/not_found', title: 'Resource Missing', status: 404 });
});

rpcServer.listen(RPC_PORT, '127.0.0.1', () => {
  console.log(`[mock-chain] Soroban RPC  → http://127.0.0.1:${RPC_PORT}`);
});

horizonServer.listen(HORIZON_PORT, '127.0.0.1', () => {
  console.log(`[mock-chain] Horizon stub → http://127.0.0.1:${HORIZON_PORT}`);
  console.log('');
  console.log('DEV ONLY — set in .env:');
  console.log(`  STELLAR_RPC_URL=http://127.0.0.1:${RPC_PORT}`);
  console.log(`  STELLAR_HORIZON_URL=http://127.0.0.1:${HORIZON_PORT}`);
  console.log('');
  console.log('Tradeoffs: no real signatures, events, or on-chain state.');
  console.log('Do NOT use for integration testing of real chain behavior.');
});
