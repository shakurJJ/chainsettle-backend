import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min, Matches } from 'class-validator';

export class UpdateTokenDto {
  @ApiProperty({ description: 'Friendly display name for the token', required: false, example: 'USD Coin' })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({ description: 'Human-readable token symbol', required: false, example: 'USDC' })
  @IsOptional()
  @Matches(/^[A-Z0-9]{1,12}$/, {
    message: 'symbol must be 1-12 uppercase alphanumeric characters',
  })
  symbol?: string;

  @ApiProperty({ description: 'Token decimal places', required: false, example: 7 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(18)
  decimals?: number;

  @ApiProperty({ description: 'Whether this token can be used for new shipments', required: false, example: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
