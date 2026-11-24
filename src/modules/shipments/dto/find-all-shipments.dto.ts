import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsString, IsIn } from 'class-validator';
import { ShipmentStatus } from '@prisma/client';
import { SUPPORTED_CURRENCIES } from '../../common/fx/fx-rate.service';

export class FindAllShipmentsDto {
  @ApiPropertyOptional({ description: 'Filter by buyer wallet address' })
  @IsOptional()
  @IsString()
  buyerAddress?: string;

  @ApiPropertyOptional({ description: 'Filter by supplier wallet address' })
  @IsOptional()
  @IsString()
  supplierAddress?: string;

  @ApiPropertyOptional({
    description: "Show shipments where any member of this organization is a participant (#435). Caller must be a member.",
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

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

  @ApiPropertyOptional({
    description:
      'Comma-separated sparse fieldset, e.g. id,status,totalAmount. id is always included; unknown fields return 400.',
    example: 'id,status,totalAmount',
  })
  @IsOptional()
  @IsString()
  fields?: string;

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

  @ApiPropertyOptional({ description: 'Filter by draft status (true = drafts only, false = on-chain only, omit = both)' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  isDraft?: boolean;

  @ApiPropertyOptional({
    description:
      'Apply a saved filter preset. Its criteria are used as the base; any ' +
      'other query param on the same request overrides the stored value.',
  })
  @IsOptional()
  @IsString()
  savedFilterId?: string;

  @ApiPropertyOptional({
    description: 'When true, return only shipments favorited by the authenticated user',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  favorite?: boolean;

  @ApiPropertyOptional({
    description:
      `Override the display currency for FX-converted values on this request. ` +
      `Supported: ${SUPPORTED_CURRENCIES.join(', ')}. ` +
      `Defaults to the user's saved displayCurrency preference (or USD if unset).`,
    enum: SUPPORTED_CURRENCIES,
    example: 'EUR',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn([...SUPPORTED_CURRENCIES], {
    message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  currency?: string;

  @ApiPropertyOptional({
    description: 'Filter shipments by computed risk level (LOW, MEDIUM, HIGH)',
    enum: ['LOW', 'MEDIUM', 'HIGH'],
    example: 'HIGH',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['LOW', 'MEDIUM', 'HIGH'], {
    message: 'riskLevel must be one of: LOW, MEDIUM, HIGH',
  })
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}
