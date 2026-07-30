import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '../../../common/decorators/is-stellar-address.decorator';

/**
 * Path-param DTO for routes shaped like GET /chain/account/:address.
 *
 * The global ValidationPipe (main.ts) has `transform: true`, so binding
 * this via `@Param() params: AddressParamDto` runs class-validator against
 * the route param before the handler executes — a malformed address is
 * rejected with 400 before we ever touch the Stellar RPC/Horizon.
 */
export class AddressParamDto {
  @ApiProperty({
    description: 'Stellar Ed25519 public key (account address)',
    example: 'GABC234567890ABCDEF234567890ABCDEF234567890ABCDEF234567890ABCD',
  })
  @IsStellarAddress()
  address: string;
}