import { IsUrl, IsArray, IsEnum, IsInt, IsOptional, IsObject, Max, Min, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { validateHeaders } from '../webhook-headers.util';

@ValidatorConstraint({ name: 'validWebhookHeaders', async: false })
export class ValidWebhookHeadersConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments) {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const err = validateHeaders(value as Record<string, string>);
    return err === null;
  }
  defaultMessage(args: ValidationArguments) {
    const value = args.object ? (args.object as any)[args.property] : undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return 'headers must be a JSON object of string -> string';
    }
    const err = validateHeaders(value as Record<string, string>);
    return err?.message ?? 'Invalid headers';
  }
}

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://example.com/webhook' })
  @IsUrl({ require_tld: false })
  url: string;

  @ApiProperty({ enum: NotificationType, isArray: true })
  @IsArray()
  @IsEnum(NotificationType, { each: true })
  events: NotificationType[];

  @ApiPropertyOptional({
    description:
      'Enable batching: deliver up to this many events per request (max 100). ' +
      'Omit or set to 1 for single-event delivery (default).',
    minimum: 1,
    maximum: 100,
    example: 50,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  batchSize?: number;

  @ApiPropertyOptional({
    description: 'Maximum time (ms) to wait before flushing a partial batch. Default 5000.',
    minimum: 100,
    maximum: 60000,
    example: 5000,
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60_000)
  batchWindowMs?: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { Authorization: 'Bearer token', 'X-Custom': 'value' },
    required: false,
    description:
      'Custom static headers sent with every delivery. ' +
      'Max 10 headers, 1 KB total (names + values). ' +
      'Reserved headers (Host, Content-Length, Content-Type, X-ChainSettle-*) are rejected.',
  })
  @IsOptional()
  @IsObject()
  @Validate(ValidWebhookHeadersConstraint)
  headers?: Record<string, string>;
}
