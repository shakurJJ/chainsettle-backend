import { SetMetadata } from '@nestjs/common';

export const DEPRECATION_KEY = 'deprecation';

export interface DeprecationMeta {
  /** Value for the Deprecation header (RFC 8594). Default: "true" */
  deprecation?: string;
  /** HTTP-date when the endpoint will be removed (Sunset header) */
  sunset?: string;
  /** Optional docs URL included in a Link header */
  link?: string;
}

/**
 * Marks a route (or controller) as deprecated.
 * DeprecationInterceptor will emit Deprecation / Sunset / Link headers.
 *
 * @example
 * @DeprecatedRoute({ sunset: 'Wed, 01 Jul 2027 00:00:00 GMT', link: '/docs#migration-v2' })
 * @Get('legacy')
 * legacyEndpoint() { ... }
 */
export const DeprecatedRoute = (meta: DeprecationMeta = {}) =>
  SetMetadata(DEPRECATION_KEY, meta);
