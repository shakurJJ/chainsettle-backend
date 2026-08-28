import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'featureFlag';

/**
 * Gates a route, or every route on a controller, behind a feature flag.
 *
 * The flag is resolved from Redis on each request by FeatureFlagGuard. When it
 * is off the route answers 404, so a gated endpoint is indistinguishable from
 * one that does not exist yet.
 *
 * Applied to a class it covers every route in that controller; applied to a
 * single handler it covers just that route, and a handler-level flag overrides
 * a controller-level one.
 *
 * @example
 * ```ts
 * // Whole controller
 * @FeatureFlag('shipment-templates')
 * @UseGuards(FeatureFlagGuard)
 * @Controller('shipment-templates')
 * export class ShipmentTemplatesController {}
 *
 * // Single route
 * @FeatureFlag('ipfs-proofs')
 * @UseGuards(FeatureFlagGuard)
 * @Post(':id/proof')
 * submitProof() {}
 * ```
 */
export const FeatureFlag = (flagName: string) =>
  SetMetadata(FEATURE_FLAG_KEY, flagName);
