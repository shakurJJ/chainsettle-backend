import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Payload shape sent by the third-party KYC provider when a verification
 * completes. Only the provider's verification result and reference ID are
 * accepted here — no raw identity documents ever pass through this endpoint.
 */
export class KycWebhookDto {
  @ApiProperty({ description: "The provider's opaque verification reference ID" })
  @IsString()
  @IsNotEmpty()
  reference: string;

  @ApiProperty({ description: 'Stellar address of the user this verification belongs to' })
  @IsString()
  @IsNotEmpty()
  stellarAddress: string;

  @ApiProperty({ enum: ['VERIFIED', 'REJECTED', 'PENDING'], description: 'Verification result' })
  @IsIn(['VERIFIED', 'REJECTED', 'PENDING'])
  status: 'VERIFIED' | 'REJECTED' | 'PENDING';
}
