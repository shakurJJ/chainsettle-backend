import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateShipmentReminderDto {
  @ApiProperty({ example: '2026-10-05T09:00:00.000Z', description: 'When to send the reminder; must be in the future' })
  @IsDateString()
  remindAt: string;

  @ApiProperty({ example: 'Check customs docs', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message: string;
}
