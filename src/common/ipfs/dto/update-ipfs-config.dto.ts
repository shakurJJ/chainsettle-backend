import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

const MIME_TYPE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;

export class UpdateIpfsConfigDto {
  @ApiPropertyOptional({
    description: 'Maximum allowed upload size in bytes (1KB - 50MB)',
    example: 10 * 1024 * 1024,
    minimum: 1024,
    maximum: 50 * 1024 * 1024,
  })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(50 * 1024 * 1024)
  maxSizeBytes?: number;

  @ApiPropertyOptional({
    description: 'Non-empty list of allowed MIME types for uploads',
    example: ['application/pdf', 'image/png'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Matches(MIME_TYPE_REGEX, {
    each: true,
    message: 'each allowedMimeTypes entry must be a valid MIME type (e.g. "application/pdf")',
  })
  allowedMimeTypes?: string[];
}
