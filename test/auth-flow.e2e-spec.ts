/**
 * Sign-In With Stellar (SIWS) Auth Flow — e2e tests
 *
 * Exercises the full HTTP flow end to end:
 *   GET  /auth/nonce   → challenge stored in Redis
 *   POST /auth/login   → signature verified, JWT issued, session registered
 *   GET  (protected)   → JWT accepted by JwtStrategy / JwtAuthGuard
 *   re-authentication  → "refresh": a fresh nonce → sign → login yields a new session
 *   POST /auth/logout  → jti blocklisted, token rejected afterwards
 *
 * A real Stellar Keypair is generated in the test and used to sign the
 * challenge, so signature verification runs exactly as in production.
 *
 * No external network calls: Redis is replaced by an in-memory fake,
 * Prisma by an in-memory user store, and audit/notification side effects
 * are mocked. Runs with the existing e2e config (test/jest-e2e.json).
 */

import { Controller, Get, INestApplication, UseGuards, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Keypair } from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { SessionService } from '../src/modules/auth/session.service';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { AuditLogService } from '../src/modules/audit-logs/audit-log.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { StellarAddressThrottlerGuard } from '../src/common/guards/stellar-address-throttler.guard';
import { AuthenticatedUser, CurrentUser } from '../src/common/decorators/current-user.decorator';

const JWT_SECRET = 'e2e-auth-flow-secret';
const JWT_EXPIRES_IN = '15m';

// ── In-memory Redis fake (only the commands the auth flow uses) ─────────────
class InMemoryRedis {
  private readonly values = new Map<string, { value: string; expiresAt?: number }>();
  private readonly sets = new Map<string, Set<string>>();

  private live(key: string) {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    this.values.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async setPx(key: string, value: string, ttlMs: number) {
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async del(key: string) {
    this.values.delete(key);
    this.sets.delete(key);
  }

  async exists(key: string) {
    return this.live(key) !== undefined || (this.sets.get(key)?.size ?? 0) > 0;
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((m) => set.add(m));
    this.sets.set(key, set);
  }

  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  async srem(key: string, ...members: string[]) {
    members.forEach((m) => this.sets.get(key)?.delete(m));
  }

  clear() {
    this.values.clear();
    this.sets.clear();
  }
}

// ── In-memory Prisma fake (users only) ──────────────────────────────────────
function createPrismaFake() {
  const users = new Map<string, { id: string; stellarAddress: string; role: string }>();
  return {
    users,
    user: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = users.get(where.stellarAddress);
        if (existing) return existing;
        const user = { id: randomUUID(), role: 'BUYER', ...create };
        users.set(user.stellarAddress, user);
        return user;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.stellarAddress) return users.get(where.stellarAddress) ?? null;
        return [...users.values()].find((u) => u.id === where.id) ?? null;
      }),
    },
  };
}

// ── Minimal protected route used to assert the JWT is honoured ──────────────
@Controller('e2e-protected')
@UseGuards(JwtAuthGuard)
class ProtectedTestController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return { id: user.id, stellarAddress: user.stellarAddress, jti: user.jti };
  }
}

describe('Sign-In With Stellar auth flow (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const redis = new InMemoryRedis();
  const prisma = createPrismaFake();
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ JWT_SECRET, JWT_EXPIRES_IN } as Record<string, unknown>)[key] ?? fallback,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: JWT_EXPIRES_IN } }),
      ],
      controllers: [AuthController, ProtectedTestController],
      providers: [
        AuthService,
        JwtStrategy,
        SessionService,
        { provide: ConfigService, useValue: config },
        { provide: RedisService, useValue: redis },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLog },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
      ],
    })
      // Rate limiting has its own coverage; keep these tests deterministic
      .overrideGuard(StellarAddressThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    jwt = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    redis.clear();
    prisma.users.clear();
    auditLog.record.mockClear();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const server = () => app.getHttpServer();

  async function getNonce(address: string): Promise<string> {
    const res = await request(server())
      .get('/auth/nonce')
      .query({ address })
      .expect(200);
    return res.body.nonce;
  }

  function sign(keypair: Keypair, nonce: string): string {
    return keypair.sign(Buffer.from(nonce)).toString('base64');
  }

  async function signIn(keypair: Keypair): Promise<string> {
    const nonce = await getNonce(keypair.publicKey());
    const res = await request(server())
      .post('/auth/login')
      .send({ stellarAddress: keypair.publicKey(), signedNonce: nonce, signature: sign(keypair, nonce) })
      .expect(200);
    return res.body.accessToken;
  }

  const getMe = (token: string) =>
    request(server()).get('/e2e-protected/me').set('Authorization', `Bearer ${token}`);

  // ── Happy path ───────────────────────────────────────────────────────────
  describe('happy path', () => {
    it('issues a nonce bound to the requested address', async () => {
      const keypair = Keypair.random();

      const res = await request(server())
        .get('/auth/nonce')
        .query({ address: keypair.publicKey() })
        .expect(200);

      expect(res.body.address).toBe(keypair.publicKey());
      expect(res.body.nonce).toContain(keypair.publicKey());
    });

    it('exchanges a signed nonce for a JWT that works on a protected route', async () => {
      const keypair = Keypair.random();
      const nonce = await getNonce(keypair.publicKey());

      const loginRes = await request(server())
        .post('/auth/login')
        .send({ stellarAddress: keypair.publicKey(), signedNonce: nonce, signature: sign(keypair, nonce) })
        .expect(200);

      const { accessToken, user } = loginRes.body;
      expect(typeof accessToken).toBe('string');
      expect(user.stellarAddress).toBe(keypair.publicKey());

      const payload = jwt.decode(accessToken) as Record<string, any>;
      expect(payload.sub).toBe(user.id);
      expect(payload.stellarAddress).toBe(keypair.publicKey());
      expect(payload.jti).toEqual(expect.any(String));
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      const meRes = await getMe(accessToken).expect(200);
      expect(meRes.body).toEqual({ id: user.id, stellarAddress: keypair.publicKey(), jti: payload.jti });

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LOGIN_SUCCESS', actorId: user.id }),
      );
    });

    it('refreshes by re-authenticating: a new nonce → sign → login issues a new session for the same user', async () => {
      const keypair = Keypair.random();

      const first = await signIn(keypair);
      const second = await signIn(keypair);

      const p1 = jwt.decode(first) as Record<string, any>;
      const p2 = jwt.decode(second) as Record<string, any>;
      expect(p2.sub).toBe(p1.sub);
      expect(p2.jti).not.toBe(p1.jti);

      await getMe(first).expect(200);
      await getMe(second).expect(200);
    });

    it('logout blocklists the token so it is rejected afterwards, while other sessions keep working', async () => {
      const keypair = Keypair.random();
      const tokenA = await signIn(keypair);
      const tokenB = await signIn(keypair);

      const logoutRes = await request(server())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(logoutRes.body.message).toBe('Logged out successfully');

      const rejected = await getMe(tokenA).expect(401);
      expect(rejected.body.message).toBe('Token has been revoked');

      // Logging out again with the blocklisted token is also rejected
      await request(server()).post('/auth/logout').set('Authorization', `Bearer ${tokenA}`).expect(401);

      // The second session is unaffected
      await getMe(tokenB).expect(200);
    });
  });

  // ── Failure paths ────────────────────────────────────────────────────────
  describe('failure paths', () => {
    it('rejects login when no nonce was requested', async () => {
      const keypair = Keypair.random();

      const res = await request(server())
        .post('/auth/login')
        .send({ stellarAddress: keypair.publicKey(), signedNonce: 'never-issued', signature: sign(keypair, 'never-issued') })
        .expect(401);

      expect(res.body.message).toContain('Nonce expired or not found');
    });

    it('rejects a signature made by a different keypair', async () => {
      const keypair = Keypair.random();
      const attacker = Keypair.random();
      const nonce = await getNonce(keypair.publicKey());

      const res = await request(server())
        .post('/auth/login')
        .send({ stellarAddress: keypair.publicKey(), signedNonce: nonce, signature: sign(attacker, nonce) })
        .expect(401);

      expect(res.body.message).toBe('Signature verification failed');
    });

    it('rejects a signature over a different message', async () => {
      const keypair = Keypair.random();
      const nonce = await getNonce(keypair.publicKey());

      await request(server())
        .post('/auth/login')
        .send({ stellarAddress: keypair.publicKey(), signedNonce: nonce, signature: sign(keypair, `${nonce}-tampered`) })
        .expect(401);
    });

    it('does not allow a nonce to be replayed after a successful login', async () => {
      const keypair = Keypair.random();
      const nonce = await getNonce(keypair.publicKey());
      const body = { stellarAddress: keypair.publicKey(), signedNonce: nonce, signature: sign(keypair, nonce) };

      await request(server()).post('/auth/login').send(body).expect(200);
      const replay = await request(server()).post('/auth/login').send(body).expect(401);

      expect(replay.body.message).toContain('Nonce expired or not found');
    });

    it('records LOGIN_FAILED for a known user who submits a bad signature', async () => {
      const keypair = Keypair.random();
      await signIn(keypair);
      auditLog.record.mockClear();

      const nonce = await getNonce(keypair.publicKey());
      await request(server())
        .post('/auth/login')
        .send({ stellarAddress: keypair.publicKey(), signedNonce: nonce, signature: sign(Keypair.random(), nonce) })
        .expect(401);

      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGIN_FAILED' }));
    });

    it('rejects a malformed login payload with 400', async () => {
      await request(server())
        .post('/auth/login')
        .send({ stellarAddress: 'not-a-stellar-address', signedNonce: 'x', signature: 'not base64!' })
        .expect(400);
    });

    it('rejects protected routes without a token', async () => {
      await request(server()).get('/e2e-protected/me').expect(401);
    });

    it('rejects a malformed bearer token', async () => {
      await getMe('not-a-jwt').expect(401);
    });

    it('rejects a token signed with a different secret', async () => {
      const forged = new JwtService({ secret: 'wrong-secret' }).sign({
        sub: randomUUID(),
        stellarAddress: Keypair.random().publicKey(),
        role: 'ADMIN',
        jti: randomUUID(),
      });

      await getMe(forged).expect(401);
    });

    it('rejects an expired token', async () => {
      // Same secret, but no default expiresIn so an explicit past `exp` can be set
      const expired = new JwtService({ secret: JWT_SECRET }).sign({
        sub: randomUUID(),
        stellarAddress: Keypair.random().publicKey(),
        role: 'BUYER',
        jti: randomUUID(),
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      await getMe(expired).expect(401);
    });

    it('rejects logout without a token', async () => {
      await request(server()).post('/auth/logout').expect(401);
    });
  });
});
