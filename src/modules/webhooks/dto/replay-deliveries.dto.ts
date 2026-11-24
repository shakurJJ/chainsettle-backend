import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

export class ReplayDeliveriesDto {
  @ApiProperty({ description: 'Replay deliveries created on or after this ISO date', example: '2026-08-01T00:00:00.000Z' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'Replay deliveries created on or before this ISO date', example: '2026-08-30T23:59:59.999Z' })
  @IsISO8601()
  to: string;
}
