import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsISO8601,
  MaxLength,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTrackingDto {
  @ApiProperty({
    description: 'Location description (e.g. "Port of Lagos", "Shanghai Warehouse")',
    example: 'Port of Lagos',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  location: string;

  @ApiPropertyOptional({
    description: 'Latitude coordinate (WGS84)',
    example: 6.5244,
  })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({
    description: 'Longitude coordinate (WGS84)',
    example: 3.3792,
  })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiProperty({
    description: 'Current shipment status',
    example: 'In Transit',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['In Transit', 'Customs Clearance', 'Out for Delivery', 'Delivered', 'At Warehouse', 'Dispatched'])
  status: string;

  @ApiPropertyOptional({
    description: 'Estimated arrival date/time (ISO 8601)',
    example: '2026-07-01T08:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  estimatedArrival?: string;

  @ApiPropertyOptional({
    description: 'Additional notes about this tracking update (max 500 characters)',
    example: 'Cleared Lagos port customs, awaiting pickup by local logistics',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
