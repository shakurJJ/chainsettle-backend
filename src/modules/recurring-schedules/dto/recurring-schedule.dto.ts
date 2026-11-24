import { ApiProperty } from '@nestjs/swagger';
import { RecurringInterval } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, IsNotEmpty, Matches } from 'class-validator';

export class CreateRecurringScheduleDto {
  @ApiProperty({ example: 'template-uuid' })
  @IsString()
  @IsNotEmpty()
  templateId: string;

  @ApiProperty({ enum: RecurringInterval, example: RecurringInterval.WEEKLY })
  @IsEnum(RecurringInterval)
  interval: RecurringInterval;

  @ApiProperty({ example: '10000000000', description: 'Draft totalAmount in stroops' })
  @Matches(/^[1-9]\d*$/, { message: 'totalAmount must be a positive integer string' })
  totalAmount: string;

  @ApiProperty({ required: false, description: 'First run time; defaults to one interval from now' })
  @IsOptional()
  @IsDateString()
  startAt?: string;
}

export class UpdateRecurringScheduleDto {
  @ApiProperty({ required: false, enum: RecurringInterval })
  @IsOptional()
  @IsEnum(RecurringInterval)
  interval?: RecurringInterval;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^[1-9]\d*$/, { message: 'totalAmount must be a positive integer string' })
  totalAmount?: string;

  @ApiProperty({ required: false, description: 'false pauses generation' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  nextRunAt?: string;
}
