import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class AgingReportQueryDto {
  @ApiPropertyOptional({
    example: true,
    default: false,
    description:
      'Include a USD valuation of each token total (converted with the cached FX rate). ' +
      'Tokens without a cached rate are omitted from the USD total and flagged by usdComplete=false.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeUsdTotal?: boolean;
}
