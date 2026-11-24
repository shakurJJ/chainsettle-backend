import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChecklistItemDto {
  @ApiProperty({ example: 'Bill of lading' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @ApiPropertyOptional({ default: true, description: 'Whether proof submission should warn if incomplete' })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

export class UpdateChecklistItemDto {
  @ApiProperty({ description: 'true marks the item complete; false reopens it' })
  @IsBoolean()
  completed: boolean;
}
