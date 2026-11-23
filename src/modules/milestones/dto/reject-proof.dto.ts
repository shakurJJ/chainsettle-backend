import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ProofRejectionReason } from '@prisma/client';

export { ProofRejectionReason };

export const REJECTION_REASON_DESCRIPTIONS: Record<ProofRejectionReason, string> = {
  ILLEGIBLE: 'The document is too blurry, dark, or low-resolution to read.',
  WRONG_DOCUMENT: 'The file is not the expected document type for this milestone.',
  INCOMPLETE: 'The document is missing required pages, signatures, or sections.',
  MISMATCHED_QUANTITY: 'The quantities, amounts, or dates in the document do not match the shipment.',
  OTHER: 'None of the above. A note is required explaining the specific problem.',
};

export class RejectProofDto {
  @ApiProperty({
    enum: ProofRejectionReason,
    description:
      'Structured reason code for the rejection. ' +
      'Allowed values: ILLEGIBLE, WRONG_DOCUMENT, INCOMPLETE, MISMATCHED_QUANTITY, OTHER. ' +
      'A note is required when OTHER is chosen.',
    example: 'INCOMPLETE',
  })
  @IsEnum(ProofRejectionReason, {
    message: `reasonCode must be one of: ${Object.values(ProofRejectionReason).join(', ')}`,
  })
  reasonCode: ProofRejectionReason;

  @ApiPropertyOptional({
    description:
      'Free-text explanation sent to the supplier. Required when reasonCode is OTHER. ' +
      'Maximum 2 000 characters.',
    maxLength: 2000,
    example: 'The stamp on page 3 is missing.',
  })
  @ValidateIf((o: RejectProofDto) => o.reasonCode === ProofRejectionReason.OTHER)
  @IsString()
  @IsNotEmpty({ message: 'note is required when reasonCode is OTHER' })
  @MaxLength(2000)
  @IsOptional()
  note?: string;
}
