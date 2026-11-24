import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RaiseDisputePrepareDto {
  @ApiPropertyOptional({ description: 'Reason recorded with the on-chain dispute' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
