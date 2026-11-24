import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
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
