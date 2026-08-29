import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

const SORTABLE_FIELDS = ['disputesOpen', 'disputesHandled', 'averageResolutionTimeHours'] as const;
export type ArbiterSortField = (typeof SORTABLE_FIELDS)[number];

/** Query DTO for GET /admin/arbiters. */
export class ListArbitersQueryDto {
  @ApiPropertyOptional({
    description: 'Sort arbiters by this reputation field, descending (default: no sorting)',
    enum: SORTABLE_FIELDS,
  })
  @IsOptional()
  @IsIn(SORTABLE_FIELDS)
  sortBy?: ArbiterSortField;
}
