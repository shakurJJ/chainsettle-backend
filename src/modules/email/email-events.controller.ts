import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  EMAIL_SIGNATURE_HEADER,
  EmailProviderEvent,
  EmailSuppressionService,
} from './email-suppression.service';

/**
 * POST /api/v1/email/events
 * Email provider webhook (bounces / complaints). Signature-verified with
 * HMAC-SHA256 over the raw body using EMAIL_WEBHOOK_SECRET (#434).
 */
@ApiTags('email')
@Controller('email')
export class EmailEventsController {
  constructor(private readonly suppressions: EmailSuppressionService) {}

  @Post('events')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email provider webhook for bounces and complaints' })
  @ApiResponse({ status: 200, description: 'Events processed' })
  @ApiResponse({ status: 401, description: 'Invalid or missing signature' })
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers(EMAIL_SIGNATURE_HEADER) signature: string | undefined,
    @Body() body: EmailProviderEvent | EmailProviderEvent[] | { events?: EmailProviderEvent[] },
  ) {
    this.suppressions.verifySignature(req.rawBody, signature);
    const events = Array.isArray(body)
      ? body
      : Array.isArray((body as any)?.events)
        ? (body as any).events
        : [body as EmailProviderEvent];
    return this.suppressions.handleEvents(events);
  }
}
