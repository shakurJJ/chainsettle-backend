import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateSavedFilterDto {
  @ApiProperty({ description: 'Display name of the saved filter', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ description: 'Serialized filter query object' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Whether the filter is shared with the organization' })
  @IsOptional()
  @IsBoolean()
  isShared?: boolean;

  @ApiPropertyOptional({
    description: 'Organization to share the filter with. Required when isShared is true.',
    format: 'uuid',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string | null;
}

export class UpdateSavedFilterDto {
  @ApiPropertyOptional({ description: 'Display name of the saved filter', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Serialized filter query object' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Whether the filter is shared with the organization' })
  @IsOptional()
  @IsBoolean()
  isShared?: boolean;

  @ApiPropertyOptional({
    description: 'Organization to share the filter with. Set to null to unshare.',
    format: 'uuid',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string | null;
}

export class SavedFilterResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  ownerId: string;

  @ApiProperty({ description: 'Display name of the saved filter' })
  name: string;

  @ApiPropertyOptional({ description: 'Serialized filter query object' })
  filters?: Record<string, unknown>;

  @ApiProperty({
    description: 'Organization the filter is shared with, or null when personal',
    format: 'uuid',
    nullable: true,
  })
  organizationId: string | null;

  @ApiProperty({ description: 'Whether the filter is shared with the organization' })
  isShared: boolean;

  @ApiProperty({ description: 'Whether the requesting user may edit this filter' })
  canEdit: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
