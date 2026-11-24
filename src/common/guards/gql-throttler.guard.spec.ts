import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { GraphQLError } from 'graphql';
import { GqlThrottlerGuard } from './gql-throttler.guard';

class ShipmentResolver {
  shipments() {
    return [];
  }
}

describe('GqlThrottlerGuard', () => {
  const DEFAULT_LIMIT = 10;
  let guard: GqlThrottlerGuard;
  let storage: { increment: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  const config = {
    get: jest.fn((key: string, def?: unknown) =>
      ({ THROTTLE_LIMIT: 10, THROTTLE_LIMIT_VERIFIED: 25, THROTTLE_LIMIT_ADMIN: 50 } as Record<string, unknown>)[key] ?? def,
    ),
  };

  const makeRes = () => ({ header: jest.fn() });

  const gqlContext = (ctx: Record<string, any>): ExecutionContext =>
    ({
      getType: () => 'graphql',
      getArgs: () => [{}, {}, ctx, {}],
      getArgByIndex: (i: number) => [{}, {}, ctx, {}][i],
      getHandler: () => ShipmentResolver.prototype.shipments,
      getClass: () => ShipmentResolver,
    }) as unknown as ExecutionContext;

  const httpContext = (req: Record<string, any>, res: Record<string, any>): ExecutionContext =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ShipmentResolver.prototype.shipments,
      getClass: () => ShipmentResolver,
    }) as unknown as ExecutionContext;

  const run = (context: ExecutionContext) =>
    (guard as any).handleRequest(
      context,
      DEFAULT_LIMIT,
      60_000,
      { name: 'default' },
      async (req: any) => req.ip ?? 'ws',
      (_ctx: ExecutionContext, tracker: string, name: string) => `${name}:${tracker}`,
    );

  beforeEach(async () => {
    storage = { increment: jest.fn() };
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    guard = new GqlThrottlerGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: DEFAULT_LIMIT }] } as any,
      storage as any,
      new Reflector(),
      config as any,
      prisma as any,
    );
    await guard.onModuleInit();
  });

  it('throttles GraphQL using the request/response from the GraphQL context', async () => {
    storage.increment.mockResolvedValue({ totalHits: 3, timeToExpire: 42 });
    const res = makeRes();

    await expect(run(gqlContext({ req: { ip: '1.2.3.4', headers: {} }, res }))).resolves.toBe(true);

    expect(storage.increment).toHaveBeenCalledWith('default:1.2.3.4', 60_000);
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '7');
  });

  it('returns a GraphQL error with code TOO_MANY_REQUESTS when over the limit', async () => {
    storage.increment.mockResolvedValue({ totalHits: 11, timeToExpire: 30 });
    const res = makeRes();

    const err = await run(gqlContext({ req: { ip: '1.2.3.4', headers: {} }, res })).catch((e: any) => e);

    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.message).toBe('Too Many Requests');
    expect(err.extensions).toMatchObject({ code: 'TOO_MANY_REQUESTS', limit: 10, retryAfter: 30 });
    expect(res.header).toHaveBeenCalledWith('Retry-After', '30');
  });

  it.each([
    ['ADMIN', 'NONE', 50],
    ['BUYER', 'VERIFIED', 25],
    ['BUYER', 'NONE', 10],
  ])('applies the same role tiers as REST (%s, kyc %s → %i)', async (role, kycStatus, expectedLimit) => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', role, kycStatus });
    storage.increment.mockResolvedValue({ totalHits: 20, timeToExpire: 30 });
    const res = makeRes();
    const context = gqlContext({ req: { ip: '1.2.3.4', headers: {}, user: { id: 'u1' } }, res });

    if (20 > expectedLimit) {
      await expect(run(context)).rejects.toBeInstanceOf(GraphQLError);
    } else {
      await expect(run(context)).resolves.toBe(true);
    }
    expect(res.header).toHaveBeenCalledWith('X-RateLimit-Limit', String(expectedLimit));
  });

  it('does not fail for GraphQL-over-WebSocket contexts without a response', async () => {
    storage.increment.mockResolvedValue({ totalHits: 1, timeToExpire: 60 });

    await expect(run(gqlContext({ req: { user: undefined, headers: {} } }))).resolves.toBe(true);
  });

  it('keeps throwing ThrottlerException (HTTP 429) for REST routes', async () => {
    storage.increment.mockResolvedValue({ totalHits: 11, timeToExpire: 30 });

    await expect(run(httpContext({ ip: '1.2.3.4', headers: {} }, makeRes()))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });
});
