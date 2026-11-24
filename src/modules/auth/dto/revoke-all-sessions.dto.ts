import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RevokeAllSessionsDto {
  @ApiPropertyOptional({
    description:
      'When true, also revokes the current session (signs the caller out too). Defaults to false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeCurrent?: boolean = false;
}
