import { IsUrl, IsArray, IsEnum, IsOptional, IsObject, IsBoolean, Validate } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { ValidWebhookHeadersConstraint } from './create-webhook.dto';

export class UpdateWebhookDto {
  @ApiProperty({ example: 'https://example.com/webhook', required: false })
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiProperty({ enum: NotificationType, isArray: true, required: false })
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationType, { each: true })
  events?: NotificationType[];

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { Authorization: 'Bearer token' },
    required: false,
    description:
      'Replaces the full custom headers map. Pass {} to clear. Max 10 headers, 1 KB total. ' +
      'Reserved headers (Host, Content-Length, Content-Type, X-ChainSettle-*) are rejected.',
  })
  @IsOptional()
  @IsObject()
  @Validate(ValidWebhookHeadersConstraint)
  headers?: Record<string, string>;

  @ApiProperty({ example: true, required: false, description: 'Set false to disable deliveries temporarily' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
