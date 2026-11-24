import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Maximum grace period: 24 hours expressed in seconds. */
export const MAX_GRACE_PERIOD_SECONDS = 86_400;

export class RotateApiKeyDto {
  /**
   * Optional window (in seconds) during which the old key remains valid after
   * rotation. This allows integrations to swap to the new key without an
   * outage window. Maximum is 24 hours (86 400 s). Defaults to 0 (immediate
   * revocation) when omitted.
   */
  @ApiPropertyOptional({
    example: 300,
    description:
      'Seconds the old key stays valid after rotation (grace period). ' +
      `Maximum ${MAX_GRACE_PERIOD_SECONDS} (24 h). Defaults to 0 (immediate revocation).`,
    minimum: 0,
    maximum: MAX_GRACE_PERIOD_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_GRACE_PERIOD_SECONDS)
  gracePeriodSeconds?: number;
}
