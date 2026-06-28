import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, Max, Min, ValidateNested } from 'class-validator';

export class MilestonePercentDto {
  @ApiProperty({ description: 'Zero-based milestone index' })
  @IsInt()
  @Min(0)
  milestoneIndex: number;

  @ApiProperty({ description: 'New payment percentage (0–100)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  paymentPercent: number;
}

export class RebalanceMilestonesDto {
  @ApiProperty({ type: [MilestonePercentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MilestonePercentDto)
  milestones: MilestonePercentDto[];
}
