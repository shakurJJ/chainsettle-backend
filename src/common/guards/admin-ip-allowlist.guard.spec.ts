import { ForbiddenException } from '@nestjs/common';
import { AdminIpAllowlistGuard } from './admin-ip-allowlist.guard';

const ctx = (url: string, ip?: string) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, ip }) }),
  }) as any;

const guard = (cidrs?: string) =>
  new AdminIpAllowlistGuard({ get: () => cidrs } as any);

describe('AdminIpAllowlistGuard', () => {
  it('is disabled when the var is unset or empty', () => {
    expect(guard(undefined).canActivate(ctx('/api/v1/admin/users', '8.8.8.8'))).toBe(true);
    expect(guard('  ').canActivate(ctx('/api/v1/admin/users', '8.8.8.8'))).toBe(true);
  });

  it('allows admin requests inside the allowlist', () => {
    const g = guard('10.0.0.0/8, 192.168.1.5, 2001:db8::/32');
    expect(g.canActivate(ctx('/api/v1/admin/users', '10.1.2.3'))).toBe(true);
    expect(g.canActivate(ctx('/api/v1/admin/users', '192.168.1.5'))).toBe(true);
    expect(g.canActivate(ctx('/api/v1/admin/users', '::ffff:10.9.9.9'))).toBe(true);
    expect(g.canActivate(ctx('/api/v1/admin/users', '2001:db8::1'))).toBe(true);
  });

  it('returns 403 for admin requests outside the allowlist', () => {
    const g = guard('10.0.0.0/8');
    expect(() => g.canActivate(ctx('/api/v1/admin/users', '8.8.8.8'))).toThrow(ForbiddenException);
    expect(() => g.canActivate(ctx('/api/v1/admin/tokens', undefined))).toThrow(ForbiddenException);
  });

  it('ignores non-admin routes', () => {
    expect(guard('10.0.0.0/8').canActivate(ctx('/api/v1/shipments?x=admin', '8.8.8.8'))).toBe(true);
    expect(guard('10.0.0.0/8').canActivate(ctx('/api/v1/administrators', '8.8.8.8'))).toBe(true);
  });

  it('rejects invalid entries at startup', () => {
    expect(() => guard('not-an-ip')).toThrow(/invalid address/);
  });
});
