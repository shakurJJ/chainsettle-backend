import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
} from 'class-validator';

export class BulkRejectMilestonesDto {
  @ApiProperty({
    type: [Number],
    description: 'Zero-based milestone indices to reject (1–20, no duplicates)',
    example: [0, 1],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  indices: number[];

  @ApiProperty({ description: 'Reason sent to each affected supplier explaining the rejection' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
