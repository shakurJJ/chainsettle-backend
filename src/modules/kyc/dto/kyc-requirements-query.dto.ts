import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsOptional } from 'class-validator';
import { IsContractAddress } from '../../../common/decorators/is-contract-address.decorator';

/** Query DTO for GET /kyc/requirements. */
export class KycRequirementsQueryDto {
  @ApiProperty({
    description: 'Estimated shipment value, in the token\'s base units (stroops)',
    example: '1000000000000',
  })
  @IsNumberString()
  value: string;

  @ApiPropertyOptional({
    description: 'Soroban contract address of the settlement token (reserved for future per-token thresholds)',
    example: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  })
  @IsOptional()
  @IsContractAddress()
  tokenAddress?: string;
}
