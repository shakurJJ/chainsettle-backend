import { IsString, IsNotEmpty, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterWebPushDto {
  @ApiProperty({
    description: 'Push service endpoint URL from the PushSubscription object',
    example: 'https://fcm.googleapis.com/fcm/send/...',
  })
  @IsUrl({ require_tld: true, require_protocol: true })
  @IsNotEmpty()
  endpoint: string;

  @ApiProperty({
    description: 'Client public key (p256dh) from PushSubscription.getKey("p256dh"), base64url-encoded',
    example: 'BNcRd...',
  })
  @IsString()
  @IsNotEmpty()
  p256dh: string;

  @ApiProperty({
    description: 'Auth secret from PushSubscription.getKey("auth"), base64url-encoded',
    example: 'tBHItJi...',
  })
  @IsString()
  @IsNotEmpty()
  auth: string;
}
