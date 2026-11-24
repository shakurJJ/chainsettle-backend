import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { EmailSuppressionService, classifyEmailEvent } from './email-suppression.service';

const SECRET = 'whsec_test';

function makeService(overrides: any = {}) {
  const prisma: any = {
    emailSuppression: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 's1', ...data })),
      delete: jest.fn(),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'u1' }),
      update: jest.fn(),
    },
    notification: { create: jest.fn() },
    ...overrides,
  };
  const config: any = { get: jest.fn((k: string) => (k === 'EMAIL_WEBHOOK_SECRET' ? SECRET : undefined)) };
  return { service: new EmailSuppressionService(prisma, config), prisma };
}

describe('EmailSuppressionService (#434)', () => {
  it('classifies hard bounces and complaints only', () => {
    expect(classifyEmailEvent({ type: 'bounce' })).toBe('BOUNCE');
    expect(classifyEmailEvent({ type: 'bounce', bounceType: 'Permanent' })).toBe('BOUNCE');
    expect(classifyEmailEvent({ type: 'bounce', bounceType: 'soft' })).toBeNull();
    expect(classifyEmailEvent({ event: 'spamreport' })).toBe('COMPLAINT');
    expect(classifyEmailEvent({ type: 'delivered' })).toBeNull();
  });

  it('accepts a valid signature and rejects invalid/missing ones', () => {
    const { service } = makeService();
    const body = Buffer.from('{"type":"bounce"}');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(() => service.verifySignature(body, sig)).not.toThrow();
    expect(() => service.verifySignature(body, `sha256=${sig}`)).not.toThrow();
    expect(() => service.verifySignature(body, 'deadbeef')).toThrow(UnauthorizedException);
    expect(() => service.verifySignature(body, undefined)).toThrow(UnauthorizedException);
    expect(() => service.verifySignature(Buffer.from('tampered'), sig)).toThrow(UnauthorizedException);
  });

  it('suppresses, unverifies the user and prompts them in-app', async () => {
    const { service, prisma } = makeService();
    const res = await service.handleEvents([
      { type: 'bounce', email: 'Bad@Example.com' },
      { type: 'delivered', email: 'ok@example.com' },
    ]);
    expect(res).toEqual({ suppressed: 1 });
    expect(prisma.emailSuppression.create).toHaveBeenCalledWith({
      data: { email: 'bad@example.com', reason: 'BOUNCE' },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { emailVerified: false } });
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', data: { action: 'UPDATE_EMAIL', reason: 'BOUNCE' } }),
      }),
    );
  });

  it('lets admins remove suppressions', async () => {
    const { service, prisma } = makeService();
    prisma.emailSuppression.findUnique.mockResolvedValue({ id: 's1', email: 'bad@example.com' });
    await expect(service.remove('s1')).resolves.toEqual({ removed: true, email: 'bad@example.com' });
    expect(prisma.emailSuppression.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
  });
});
