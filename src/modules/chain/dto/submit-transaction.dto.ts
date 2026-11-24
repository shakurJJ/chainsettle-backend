import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SubmitTransactionDto {
  @ApiProperty({ description: 'Base64 XDR of the signed transaction envelope' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  signedXdr: string;
}
