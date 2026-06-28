import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsString } from 'class-validator';
import { ShipmentStatus } from '@prisma/client';

export class FindAllShipmentsDto {
  @ApiPropertyOptional({ description: 'Filter by buyer wallet address' })
  @IsOptional()
  @IsString()
  buyerAddress?: string;

  @ApiPropertyOptional({ description: 'Filter by supplier wallet address' })
  @IsOptional()
  @IsString()
  supplierAddress?: string;

  @ApiPropertyOptional({ description: 'Filter by shipment status', enum: ShipmentStatus })
  @IsOptional()
  @IsString()
  status?: ShipmentStatus;

  @ApiPropertyOptional({ description: 'Filter by reference number (exact match)' })
  @IsOptional()
  @IsString()
  referenceNumber?: string;

  @ApiPropertyOptional({ description: 'Filter by tags (comma-separated)' })
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based, default: 1)' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ description: 'Items per page (default: 20)' })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    description:
      'Opaque base64 cursor for forward pagination. Mutually exclusive with page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Search in description (full-text search)' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter shipments created on or after this ISO date',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  createdAfter?: string;

  @ApiPropertyOptional({
    description: 'Filter shipments created on or before this ISO date',
    example: '2026-03-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601()
  createdBefore?: string;

  @ApiPropertyOptional({
    description: 'Filter shipments updated on or after this ISO date',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  updatedAfter?: string;

  @ApiPropertyOptional({
    description: 'Filter shipments updated on or before this ISO date',
    example: '2026-03-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601()
  updatedBefore?: string;

  @ApiPropertyOptional({ description: 'Include archived shipments in results (default: false)' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  includeArchived?: boolean;
}
