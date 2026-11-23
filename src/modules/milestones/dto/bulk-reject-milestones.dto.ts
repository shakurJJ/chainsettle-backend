import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProofRejectionReason } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class BulkRejectMilestonesDto {
  @ApiProperty({
    type: [Number],
    description: 'Zero-based milestone indices to reject (1–20, no duplicates)',
    example: [0, 1],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  indices: number[];

  @ApiProperty({
    enum: ProofRejectionReason,
    description:
      'Structured reason code applied to every rejected milestone. ' +
      'Allowed values: ILLEGIBLE, WRONG_DOCUMENT, INCOMPLETE, MISMATCHED_QUANTITY, OTHER. ' +
      'A note is required when OTHER is chosen.',
    example: 'WRONG_DOCUMENT',
  })
  @IsEnum(ProofRejectionReason, {
    message: `reasonCode must be one of: ${Object.values(ProofRejectionReason).join(', ')}`,
  })
  reasonCode: ProofRejectionReason;

  @ApiPropertyOptional({
    description:
      'Free-text explanation sent to each affected supplier. ' +
      'Required when reasonCode is OTHER. Maximum 2 000 characters.',
    maxLength: 2000,
  })
  @ValidateIf((o: BulkRejectMilestonesDto) => o.reasonCode === ProofRejectionReason.OTHER)
  @IsString()
  @IsNotEmpty({ message: 'note is required when reasonCode is OTHER' })
  @MaxLength(2000)
  @IsOptional()
  note?: string;

  /**
   * @deprecated Use `note` instead. Kept for backward-compatibility with
   * callers that still send the old `reason` string field; ignored when
   * `note` is also present.
   */
  @ApiPropertyOptional({
    description: '[Deprecated] Use note instead.',
    deprecated: true,
  })
  @IsString()
  @IsOptional()
  reason?: string;
}
