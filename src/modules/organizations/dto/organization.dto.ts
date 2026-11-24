import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MilestoneDto } from '../../shipments/dto/create-shipment.dto';
import { OrganizationRole } from '@prisma/client';

export class CreateOrganizationDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
}

export class AddOrganizationMemberDto {
  @ApiPropertyOptional({ description: 'User id to add (or pass stellarAddress)' })
  @ValidateIf((o) => !o.stellarAddress)
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Stellar address of the user to add' })
  @ValidateIf((o) => !o.userId)
  @IsString()
  @IsNotEmpty()
  stellarAddress?: string;

  @ApiPropertyOptional({ enum: OrganizationRole, default: OrganizationRole.MEMBER })
  @IsOptional()
  @IsEnum(OrganizationRole)
  role?: OrganizationRole;
}

export class ChangeOrganizationRoleDto {
  @ApiProperty({ enum: OrganizationRole })
  @IsEnum(OrganizationRole)
  role: OrganizationRole;
}

/** Default shipment settings for an organization (#646). */
export class OrganizationDefaultsDto {
  @ApiPropertyOptional({ description: 'Default token contract address (must be in the token registry)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  tokenAddress?: string;

  @ApiPropertyOptional({ description: 'Default arbiter Stellar address' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  arbiterAddress?: string;

  @ApiPropertyOptional({ type: [MilestoneDto], description: 'Default milestone template' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MilestoneDto)
  milestones?: MilestoneDto[];
}

/** Filters for GET /organizations/:id/audit-logs (#645). */
export class OrganizationAuditLogQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
