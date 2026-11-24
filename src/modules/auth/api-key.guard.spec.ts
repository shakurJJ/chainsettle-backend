/**
 * Unit tests for ApiKeyGuard scope enforcement.
 *
 * Tested without passport-custom by directly exercising handleRequest(),
 * which is the method that implements scope enforcement after authentication.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/** Build a minimal fake ExecutionContext for a given HTTP method. */
function makeCtx(method: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method }),
    }),
  } as unknown as ExecutionContext;
}

/** User shape returned by ApiKeyStrategy.validate() */
function makeUser(scopes: string[]) {
  return { id: 'u1', stellarAddress: 'GABC', _apiKeyScopes: scopes };
}

describe('ApiKeyGuard — scope enforcement', () => {
  let guard: ApiKeyGuard;

  beforeEach(() => {
    guard = new ApiKeyGuard();
  });

  // ── Read-only key ──────────────────────────────────────────────────────────

  it('allows GET with a read-only key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('GET')),
    ).not.toThrow();
  });

  it('allows HEAD with a read-only key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('HEAD')),
    ).not.toThrow();
  });

  it('rejects POST with a read-only key — API_KEY_SCOPE_INSUFFICIENT', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('POST')),
    ).toThrow(ForbiddenException);

    try {
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('POST'));
    } catch (err) {
      expect((err as ForbiddenException).message).toBe('API_KEY_SCOPE_INSUFFICIENT');
    }
  });

  it('rejects PUT with a read-only key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('PUT')),
    ).toThrow(ForbiddenException);
  });

  it('rejects PATCH with a read-only key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('PATCH')),
    ).toThrow(ForbiddenException);
  });

  it('rejects DELETE with a read-only key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read']), null, makeCtx('DELETE')),
    ).toThrow(ForbiddenException);
  });

  // ── Read-write key ─────────────────────────────────────────────────────────

  it('allows POST with a read-write key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read', 'write']), null, makeCtx('POST')),
    ).not.toThrow();
  });

  it('allows PATCH with a read-write key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read', 'write']), null, makeCtx('PATCH')),
    ).not.toThrow();
  });

  it('allows DELETE with a read-write key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read', 'write']), null, makeCtx('DELETE')),
    ).not.toThrow();
  });

  it('allows GET with a read-write key', () => {
    expect(() =>
      guard.handleRequest(null, makeUser(['read', 'write']), null, makeCtx('GET')),
    ).not.toThrow();
  });

  // ── Missing / default scopes (backward compat) ────────────────────────────

  it('treats missing _apiKeyScopes as full access — allows POST', () => {
    const userWithoutScopes = { id: 'u1' } as any;
    expect(() =>
      guard.handleRequest(null, userWithoutScopes, null, makeCtx('POST')),
    ).not.toThrow();
  });

  // ── Auth errors ────────────────────────────────────────────────────────────

  it('re-throws authentication errors', () => {
    const err = new ForbiddenException('API_KEY_EXPIRED');
    expect(() =>
      guard.handleRequest(err, false, null, makeCtx('GET')),
    ).toThrow(err);
  });

  it('throws when user is falsy (no user resolved)', () => {
    expect(() =>
      guard.handleRequest(null, false, null, makeCtx('GET')),
    ).toThrow(ForbiddenException);
  });

  // ── JWT auth unaffected ────────────────────────────────────────────────────
  // JWT requests never reach ApiKeyGuard — they use JwtAuthGuard instead.
  // This test documents that a JWT-shaped user (no _apiKeyScopes) gets
  // default full-access treatment if somehow passed through.

  it('JWT-shaped user (no _apiKeyScopes) gets full access by default', () => {
    const jwtUser = { id: 'u1', stellarAddress: 'GABC', role: 'BUYER' } as any;
    expect(() =>
      guard.handleRequest(null, jwtUser, null, makeCtx('POST')),
    ).not.toThrow();
  });
});
