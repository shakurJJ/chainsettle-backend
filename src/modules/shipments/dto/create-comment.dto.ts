import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentVisibility } from '@prisma/client';

export class CreateCommentDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({ enum: CommentVisibility, default: CommentVisibility.ALL })
  @IsOptional()
  @IsEnum(CommentVisibility)
  visibility?: CommentVisibility;

  @ApiPropertyOptional({ description: 'IPFS CID of an attached file (upload to IPFS first)' })
  @IsOptional()
  @IsString()
  attachmentCid?: string;

  @ApiPropertyOptional({ description: 'ID of the comment this is a reply to (must be on the same shipment)' })
  @IsOptional()
  @IsUUID()
  parentCommentId?: string;

  @ApiPropertyOptional({ description: 'Index of the milestone this comment is about (must exist on the shipment)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  milestoneIndex?: number;
}
