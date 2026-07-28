import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsISO8601,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AppendMilestoneDto {
  @ApiProperty({ example: 'Customs Clearance', description: 'Name of the new milestone' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 15, description: 'Payment percentage for this milestone (1–100)' })
  @IsInt()
  @Min(1)
  @Max(100)
  paymentPercent: number;

  @ApiProperty({ required: false, example: '2026-09-30T23:59:59Z', description: 'Optional milestone deadline (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}
