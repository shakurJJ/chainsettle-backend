import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateAvailabilityDto {
  @ApiPropertyOptional({
    description: 'ISO-8601 time until which the arbiter is away. Send null to clear.',
    nullable: true,
    example: '2026-10-15T00:00:00.000Z',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  awayUntil?: string | null;

  @ApiPropertyOptional({ description: 'Optional note shown while away', maxLength: 500, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(500)
  awayMessage?: string | null;
}
