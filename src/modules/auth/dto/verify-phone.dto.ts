import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsE164 } from '../../../common/validators/is-e164.validator';

/**
 * DTO for initiating phone number verification.
 * User provides their phone number in E.164 format.
 */
export class SetPhoneDto {
  @ApiProperty({
    example: '+14155551234',
    description: 'Phone number in E.164 format (e.g., +14155551234)',
  })
  @IsString()
  @IsE164()
  @MaxLength(15)
  phoneNumber: string;
}

/**
 * DTO for confirming phone number with OTP.
 */
export class VerifyPhoneDto {
  @ApiProperty({
    example: '123456',
    description: 'One-time password sent to the phone number',
  })
  @IsString()
  @MaxLength(6)
  otp: string;
}