import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateExtensionRequestDto {
  @ApiProperty({ example: '2026-12-01T00:00:00.000Z', description: 'Requested new dueAt (must be in the future and later than the current dueAt)' })
  @IsISO8601()
  proposedDueAt: string;

  @ApiProperty({ example: 'Port congestion in Lagos delayed loading by 10 days' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class DecideExtensionRequestDto {
  @ApiPropertyOptional({ example: 'Agreed, please send updated ETA', description: 'Optional note included in the notification' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
