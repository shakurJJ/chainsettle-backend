import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export type ShipmentDocumentSource = 'PROOF' | 'DISPUTE_EVIDENCE' | 'COMMENT';

export class ShipmentDocumentDto {
  @ApiProperty({
    description: 'Source of the document',
    enum: ['PROOF', 'DISPUTE_EVIDENCE', 'COMMENT'],
    example: 'PROOF',
  })
  source: ShipmentDocumentSource;

  @ApiProperty({
    description: 'IPFS Content Identifier (CID)',
    example: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  })
  cid: string;

  @ApiPropertyOptional({
    description: 'Original file name if available',
    example: 'bill-of-lading.pdf',
  })
  fileName?: string;

  @ApiPropertyOptional({
    description: 'MIME type of the file if available',
    example: 'application/pdf',
  })
  mimeType?: string;

  @ApiProperty({
    description: 'Stellar address of the uploader',
    example: 'GBUYER7X...',
  })
  uploadedBy: string;

  @ApiProperty({
    description: 'Timestamp when the document was uploaded',
    example: '2026-06-01T12:00:00.000Z',
  })
  uploadedAt: Date | string;

  @ApiPropertyOptional({
    description: 'Milestone index if document is associated with a milestone',
    example: 0,
  })
  milestoneIndex?: number;

  @ApiProperty({
    description: 'Access-controlled proxy URL to download the document',
    example: '/api/v1/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  })
  downloadUrl: string;
}

export class FindShipmentDocumentsDto {
  @ApiPropertyOptional({
    description: 'Filter by document source (PROOF, DISPUTE_EVIDENCE, COMMENT)',
    enum: ['PROOF', 'DISPUTE_EVIDENCE', 'COMMENT'],
  })
  @IsOptional()
  @IsString()
  source?: string;
}
