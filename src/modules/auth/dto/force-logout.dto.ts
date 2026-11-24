import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ForceLogoutDto {
  @ApiPropertyOptional({
    description:
      'When true, also revokes all active API keys for the target user. Defaults to false.',
    default: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  revokeApiKeys?: boolean = false;
}
