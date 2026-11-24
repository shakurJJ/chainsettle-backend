import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for PATCH /arbiters/me/directory — an arbiter's own directory settings (#398). */
export class UpdateDirectoryProfileDto {
  @ApiPropertyOptional({
    description: 'Show this arbiter in GET /arbiters (default true)',
  })
  @IsOptional()
  @IsBoolean()
  listedInDirectory?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the arbiter is accepting new cases',
  })
  @IsOptional()
  @IsBoolean()
  available?: boolean;

  @ApiPropertyOptional({ description: 'Organization shown in the directory' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  organization?: string;
}
