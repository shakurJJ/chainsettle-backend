import { IsUrl, IsArray, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';

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
}
