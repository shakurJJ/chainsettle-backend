import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class RewindCursorDto {
  @ApiProperty({
    description:
      'Stellar ledger sequence number to rewind the event-poller cursor to. ' +
      'Must be within the RPC node retention window (typically ~17 days / ~288 000 ledgers). ' +
      'All events from this ledger onward will be reprocessed.',
    example: 5_200_000,
    type: Number,
  })
  @Type(() => Number)
  @IsInt({ message: 'toLedger must be an integer' })
  @Min(1, { message: 'toLedger must be at least 1' })
  toLedger: number;

  @ApiProperty({
    description:
      'Human-readable reason for the rewind, stored in the audit log. ' +
      'Required so the action is fully traceable.',
    example: 'Bug fix in handleMilestoneConfirmed — reprocessing affected ledger range',
    minLength: 5,
    maxLength: 500,
  })
  @IsString({ message: 'reason must be a string' })
  @MinLength(5, { message: 'reason must be at least 5 characters' })
  @MaxLength(500, { message: 'reason must not exceed 500 characters' })
  reason: string;
}
