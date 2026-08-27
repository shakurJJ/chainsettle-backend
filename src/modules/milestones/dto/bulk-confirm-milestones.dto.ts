import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class BulkConfirmItemDto {
  @ApiProperty({ description: 'Zero-based milestone index to confirm' })
  @IsInt()
  @Min(0)
  milestoneIndex: number;

  @ApiProperty({ description: 'On-chain transaction hash of the confirm_milestone call' })
  @IsString()
  @IsNotEmpty()
  txHash: string;

  @ApiProperty({
    example: '1000000000',
    description: 'Amount released to the supplier, in stroops',
  })
  @IsString()
  @IsNotEmpty()
  paymentReleased: string;
}

export class BulkConfirmMilestonesDto {
  @ApiProperty({
    type: [BulkConfirmItemDto],
    description: 'Milestones to confirm in this batch (1–20)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BulkConfirmItemDto)
  milestones: BulkConfirmItemDto[];
}
