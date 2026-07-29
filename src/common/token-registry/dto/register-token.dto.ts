import { IsInt, Matches, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsContractAddress } from '../../decorators/is-contract-address.decorator';

export class RegisterTokenDto {
  @ApiProperty({
    description: 'Token contract address (Soroban "C..." address)',
    example: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  })
  @IsContractAddress()
  address: string;

  @ApiProperty({ description: '1-12 uppercase alphanumeric characters', example: 'USDT' })
  @Matches(/^[A-Z0-9]{1,12}$/, {
    message: 'symbol must be 1-12 uppercase alphanumeric characters',
  })
  symbol: string;

  @ApiProperty({ description: 'Token decimal places (0-18)', example: 7 })
  @IsInt()
  @Min(0)
  @Max(18)
  decimals: number;
}