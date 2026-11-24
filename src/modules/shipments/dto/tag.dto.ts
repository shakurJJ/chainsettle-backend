import {
  ArrayMaxSize,
  IsArray,
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

export const MAX_TAGS_PER_SHIPMENT = 20;
export const MAX_REPLACE_TAG_LENGTH = 30;

export class ReplaceTagsDto {
  @ApiProperty({
    type: [String],
    example: ['urgent', 'fragile'],
    maxItems: MAX_TAGS_PER_SHIPMENT,
    description: `Full replacement tag list (max ${MAX_TAGS_PER_SHIPMENT} tags, each 1-${MAX_REPLACE_TAG_LENGTH} chars, no spaces)`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_TAGS_PER_SHIPMENT, { message: `A shipment can have at most ${MAX_TAGS_PER_SHIPMENT} tags` })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(MAX_REPLACE_TAG_LENGTH, {
    each: true,
    message: `each tag must be ${MAX_REPLACE_TAG_LENGTH} characters or less`,
  })
  @Matches(/^[^\s]+$/, { each: true, message: 'Tag cannot contain spaces' })
  tags: string[];
}
