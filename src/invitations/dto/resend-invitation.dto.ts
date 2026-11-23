import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ResendInvitationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
