import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitTransactionDto {
  @ApiProperty({ description: 'Base64 XDR of the signed transaction envelope' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  signedXdr: string;

  @ApiPropertyOptional({
    description: 'Wrap the transaction in a fee bump paid by the platform sponsor account (subject to a daily per-user cap)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  sponsor?: boolean;
}
