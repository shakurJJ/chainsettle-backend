import * as express from 'express';
import * as http from 'http';
import { AddressInfo } from 'net';
import { createBodyLimitMiddleware, jsonDepth, resolveBodyLimit } from './body-limit.middleware';

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

async function post(server: http.Server, path: string, body: string) {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

describe('body limit middleware (#433)', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.use(
      createBodyLimitMiddleware({
        routes: [{ method: 'POST', pattern: /\/big$/, limit: '1mb' }],
        defaultLimit: '1kb',
        maxDepth: 5,
      }),
    );
    app.post('*', (req: any, res) => res.json({ ok: true, raw: !!req.rawBody }));
    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('accepts small bodies and keeps the raw body', async () => {
    const res = await post(server, '/small', JSON.stringify({ a: 1 }));
    expect(res).toEqual({ status: 200, body: { ok: true, raw: true } });
  });

  it('rejects oversized bodies with 413 in the standard error format', async () => {
    const res = await post(server, '/small', JSON.stringify({ a: 'x'.repeat(2048) }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, statusCode: 413, path: '/small' });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.timestamp).toBeDefined();
  });

  it('allows larger bodies on configured routes', async () => {
    const res = await post(server, '/big', JSON.stringify({ a: 'x'.repeat(4096) }));
    expect(res.status).toBe(200);
  });

  it('rejects deeply nested JSON', async () => {
    const ok = await post(server, '/small', JSON.stringify(nested(5)));
    expect(ok.status).toBe(200);
    const res = await post(server, '/small', JSON.stringify(nested(6)));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, statusCode: 400 });
  });

  it('resolves per-route limits with a 100kb default', () => {
    expect(resolveBodyLimit('POST', '/api/v1/shipments/import')).toBe('5mb');
    expect(resolveBodyLimit('POST', '/api/v1/shipments/abc/comments')).toBe('100kb');
    expect(resolveBodyLimit('GET', '/api/v1/shipments/import')).toBe('100kb');
  });

  it('computes JSON depth', () => {
    expect(jsonDepth(1)).toBe(0);
    expect(jsonDepth({ a: [1, { b: 2 }] })).toBe(3);
    expect(jsonDepth(nested(30), 20)).toBe(21);
  });
});
