import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateSavedFilterDto {
  @ApiProperty({
    example: 'My overdue shipments as supplier',
    description: 'Name for this preset, unique among your own saved filters',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: { status: 'DISPUTED', tags: 'urgent' },
    description:
      'Filter criteria to store. Accepts the GET /shipments filter fields; ' +
      'pagination params are not stored, since they are per-request.',
  })
  @IsObject()
  filter: Record<string, unknown>;
}

export class UpdateSavedFilterDto {
  @ApiPropertyOptional({ example: 'Overdue as supplier' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: { status: 'ACTIVE' } })
  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;
}
