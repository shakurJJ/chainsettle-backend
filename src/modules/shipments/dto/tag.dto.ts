import {
  IsString,
  IsNotEmpty,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddTagDto {
  @ApiProperty({ 
    example: 'urgent', 
    description: 'Tag to add (max 50 chars, no spaces, non-empty)' 
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50, { message: 'Tag must be 50 characters or less' })
  @Matches(/^[^\s]+$/, { message: 'Tag cannot contain spaces' })
  tag: string;
}