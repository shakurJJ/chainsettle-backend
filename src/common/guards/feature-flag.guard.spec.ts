import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagGuard } from './feature-flag.guard';
import { FEATURE_FLAG_KEY } from '../decorators/feature-flag.decorator';
import { FeatureFlagsService } from '../../modules/feature-flags/feature-flags.service';

describe('FeatureFlagGuard', () => {
  let guard: FeatureFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let featureFlags: { isEnabled: jest.Mock };

  const handler = () => undefined;
  class DummyController {}

  function contextFor(user?: unknown): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => DummyController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    featureFlags = { isEnabled: jest.fn() };
    guard = new FeatureFlagGuard(
      reflector as unknown as Reflector,
      featureFlags as unknown as FeatureFlagsService,
    );
  });

  // -- Ungated routes ---------------------------------------------------------

  it('allows a route carrying no flag metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    expect(featureFlags.isEnabled).not.toHaveBeenCalled();
  });

  it('reads metadata from both the handler and the controller class', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(true);

    await guard.canActivate(contextFor());

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(FEATURE_FLAG_KEY, [
      handler,
      DummyController,
    ]);
  });

  // -- Gating -----------------------------------------------------------------

  it('allows the route when the flag is on', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(true);

    await expect(guard.canActivate(contextFor({ id: 'user-1' }))).resolves.toBe(
      true,
    );
  });

  it('answers 404 when the flag is off', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(false);

    await expect(guard.canActivate(contextFor({ id: 'user-1' }))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('hides a disabled route rather than admitting it exists', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(false);

    // A 403 would confirm the route is present and merely switched off, which
    // leaks unreleased functionality. 404 is indistinguishable from no route.
    await expect(
      guard.canActivate(contextFor({ id: 'user-1' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  // -- Rollout subject --------------------------------------------------------

  it('buckets a percentage rollout on the user id', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(true);

    await guard.canActivate(contextFor({ id: 'user-1', stellarAddress: 'GABC' }));

    expect(featureFlags.isEnabled).toHaveBeenCalledWith('templates', 'user-1');
  });

  it('falls back to the Stellar address when there is no user id', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(true);

    await guard.canActivate(contextFor({ stellarAddress: 'GABC' }));

    expect(featureFlags.isEnabled).toHaveBeenCalledWith('templates', 'GABC');
  });

  it('passes no subject for an unauthenticated request', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');
    featureFlags.isEnabled.mockResolvedValue(true);

    await guard.canActivate(contextFor(undefined));

    expect(featureFlags.isEnabled).toHaveBeenCalledWith('templates', undefined);
  });

  // -- Live toggling ----------------------------------------------------------

  it('re-resolves the flag on every request', async () => {
    reflector.getAllAndOverride.mockReturnValue('templates');

    featureFlags.isEnabled.mockResolvedValueOnce(true);
    await expect(guard.canActivate(contextFor({ id: 'u' }))).resolves.toBe(true);

    featureFlags.isEnabled.mockResolvedValueOnce(false);
    await expect(guard.canActivate(contextFor({ id: 'u' }))).rejects.toThrow(
      NotFoundException,
    );

    expect(featureFlags.isEnabled).toHaveBeenCalledTimes(2);
  });
});
