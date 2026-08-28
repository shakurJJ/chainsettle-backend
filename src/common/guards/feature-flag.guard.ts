import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_FLAG_KEY } from '../decorators/feature-flag.decorator';
import { FeatureFlagsService } from '../../modules/feature-flags/feature-flags.service';

/**
 * Enforces @FeatureFlag() metadata.
 *
 * A route with no flag is always allowed, so applying this guard globally or
 * on a controller costs nothing for ungated routes.
 *
 * When a flag is off the guard throws NotFoundException rather than a 403.
 * A disabled endpoint should look like it does not exist: a 403 would confirm
 * the route is there and merely switched off, which leaks unreleased
 * functionality.
 *
 * The flag is read from Redis per request, so flipping it takes effect
 * immediately without restarting the app.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler-level metadata wins over controller-level.
    const flagName = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!flagName) return true;

    const { user } = context.switchToHttp().getRequest();
    // Percentage rollouts bucket on a stable per-caller id. Prefer the user id,
    // fall back to the Stellar address for token-authenticated callers.
    const subjectId: string | undefined = user?.id ?? user?.stellarAddress;

    const enabled = await this.featureFlags.isEnabled(flagName, subjectId);
    if (!enabled) {
      throw new NotFoundException();
    }

    return true;
  }
}
