import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/**
 * Path-param DTO for routes shaped like GET /chain/transactions/:hash.
 *
 * The global ValidationPipe (main.ts) has `transform: true`, so binding
 * this via `@Param() params: TxHashParamDto` runs class-validator against
 * the route param before the handler executes — an invalid hash is
 * rejected with 400 before we ever touch the Stellar RPC.
 */
export class TxHashParamDto {
  @ApiProperty({
    description: 'Stellar transaction hash — 64 lowercase or uppercase hex characters',
    example: 'a'.repeat(64),
  })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'hash must be a 64-character hexadecimal string',
  })
  hash: string;
}
