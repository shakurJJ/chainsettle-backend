import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

export const INVITABLE_ROLES = [UserRole.SUPPLIER, UserRole.LOGISTICS, UserRole.ARBITER] as const;

export class CreateInvitationDto {
  @ApiProperty({ example: 'partner@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: INVITABLE_ROLES })
  @IsIn(INVITABLE_ROLES)
  role: UserRole;

  @ApiPropertyOptional({ description: 'Shipment the invitee is being invited to' })
  @IsOptional()
  @IsString()
  shipmentId?: string;

  @ApiPropertyOptional({ description: 'Shipment template the invitee is being invited to' })
  @IsOptional()
  @IsString()
  templateId?: string;
}
