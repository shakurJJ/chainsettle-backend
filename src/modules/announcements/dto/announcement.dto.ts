import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AnnouncementSeverity, UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsDate, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateAnnouncementDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({
    enum: AnnouncementSeverity,
    default: AnnouncementSeverity.INFO,
  })
  @IsOptional()
  @IsEnum(AnnouncementSeverity)
  severity?: AnnouncementSeverity;

  @ApiPropertyOptional({
    description: 'When the banner starts showing (default: now)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional({
    description: 'When the banner stops showing (default: never)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @ApiPropertyOptional({
    enum: UserRole,
    isArray: true,
    description: 'Roles that see it (empty = everyone)',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(UserRole, { each: true })
  audienceRoles?: UserRole[];
}

export class UpdateAnnouncementDto extends PartialType(CreateAnnouncementDto) {}

export class ListAnnouncementsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
