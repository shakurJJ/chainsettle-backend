import { IsIn, IsObject, IsOptional, IsString, IsUrl, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { DigestFrequency } from '../notifications.service';

const DIGEST_FREQUENCIES: DigestFrequency[] = ['instant', 'daily', 'weekly'];

export class UpdatePreferencesDto {
  @ApiProperty({
    description: 'Partial map of NotificationType to channel flags',
    example: { PROOF_SUBMITTED: { inApp: true, email: false, slack: true } },
    required: false,
  })
  @IsOptional()
  @IsObject()
  preferences?: Partial<
    Record<NotificationType, { inApp: boolean; email: boolean; slack?: boolean }>
  >;

  @ApiProperty({
    description: 'How often to receive the notification digest email',
    enum: DIGEST_FREQUENCIES,
    required: false,
  })
  @IsOptional()
  @IsIn(DIGEST_FREQUENCIES)
  digestFrequency?: DigestFrequency;

  @ApiProperty({
    description:
      'Slack Incoming Webhook URL for milestone/shipment events. Pass null or empty string to remove.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl({ require_tld: false })
  @IsString()
  slackWebhookUrl?: string | null;
}
