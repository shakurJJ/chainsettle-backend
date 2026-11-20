import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitDisputeRationaleDto {
  @ApiProperty({
    description: 'Markdown rationale for the arbiter decision',
    example: '## Decision\n\nThe supplier did not establish timely delivery.',
    maxLength: 50000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50000)
  rationale: string;

  @ApiPropertyOptional({
    description: 'Optional IPFS CID for a supporting rationale document',
    example: 'bafybeigdyrzt...',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  ipfsCid?: string;
}
