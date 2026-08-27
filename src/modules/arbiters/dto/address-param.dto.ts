import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '../../../common/decorators/is-stellar-address.decorator';

/** Path-param DTO for GET /arbiters/:address/reputation. */
export class AddressParamDto {
  @ApiProperty({
    description: 'Stellar Ed25519 public key (arbiter address)',
    example: 'GABC234567890ABCDEF234567890ABCDEF234567890ABCDEF234567890ABCD',
  })
  @IsStellarAddress()
  address: string;
}
