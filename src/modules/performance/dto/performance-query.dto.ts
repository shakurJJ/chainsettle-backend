import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';

export const PERFORMANCE_ROLES = ['SUPPLIER', 'LOGISTICS'] as const;
export type PerformanceRole = (typeof PERFORMANCE_ROLES)[number];

export class PerformanceQueryDto {
  @ApiPropertyOptional({ enum: PERFORMANCE_ROLES, description: 'Restrict to shipments where the address held this role. Default: both.' })
  @IsOptional()
  @IsIn(PERFORMANCE_ROLES)
  role?: PerformanceRole;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z', description: 'Only shipments created on or after this date' })
  @IsOptional()
  @IsISO8601()
  since?: string;
}
