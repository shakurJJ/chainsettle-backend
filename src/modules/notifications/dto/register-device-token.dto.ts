import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDeviceTokenDto {
  @ApiProperty({ example: 'fcm-registration-token-here' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ enum: ['fcm'], default: 'fcm', required: false })
  @IsOptional()
  @IsIn(['fcm'])
  platform?: string;
}
