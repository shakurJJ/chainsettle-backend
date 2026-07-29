import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as exempt from JwtAuthGuard, even when the guard is applied
 * at the controller (class) level. See JwtAuthGuard.canActivate — it checks
 * for this metadata via Reflector before falling back to normal JWT auth.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);