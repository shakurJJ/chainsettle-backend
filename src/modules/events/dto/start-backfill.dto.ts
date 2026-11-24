import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Maximum ledger span allowed in a single backfill request (~5.8 days at 5 s/ledger). */
export const MAX_BACKFILL_RANGE = 100_000;

export class StartBackfillDto {
  @ApiProperty({
    description:
      'First Stellar ledger sequence number to include in the backfill (inclusive). ' +
      'Must be within the RPC node retention window.',
    example: 5_100_000,
    type: Number,
  })
  @Type(() => Number)
  @IsInt({ message: 'fromLedger must be an integer' })
  @Min(1, { message: 'fromLedger must be at least 1' })
  fromLedger: number;

  @ApiProperty({
    description:
      'Last Stellar ledger sequence number to include in the backfill (inclusive). ' +
      `Must be ≥ fromLedger and at most ${MAX_BACKFILL_RANGE.toLocaleString()} ledgers ahead of fromLedger.`,
    example: 5_200_000,
    type: Number,
  })
  @Type(() => Number)
  @IsInt({ message: 'toLedger must be an integer' })
  @Min(1, { message: 'toLedger must be at least 1' })
  toLedger: number;
}
