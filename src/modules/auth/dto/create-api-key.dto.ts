import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsDateString,
  IsArray,
  IsIn,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsFutureDate } from '../../../common/validators/is-future-date.validator';
import { IsAtMostOneYearAhead } from '../../../common/validators/is-at-most-one-year-ahead.validator';

/** All valid scope tokens. Add new ones here as the surface area grows. */
export const API_KEY_SCOPES = ['read', 'write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export class CreateApiKeyDto {
  @ApiProperty({
    example: 'CI Pipeline',
    description: 'A human-readable label for this API key',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({
    example: ['read'],
    description:
      'Scopes granted to this key. Allowed values: "read", "write". ' +
      'Defaults to ["read", "write"] (full access) if omitted. ' +
      'A key with only "read" can call GET/HEAD endpoints; POST/PATCH/PUT/DELETE require "write".',
    type: [String],
    enum: API_KEY_SCOPES,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(API_KEY_SCOPES.length)
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes?: ApiKeyScope[];

  @ApiPropertyOptional({
    example: '2027-09-25T00:00:00.000Z',
    description:
      'Optional expiry date (ISO 8601). Must be in the future and at most 1 year from now. Omit for a non-expiring key.',
  })
  @IsOptional()
  @IsDateString()
  @IsFutureDate()
  @IsAtMostOneYearAhead()
  expiresAt?: string;
}
