import { ExceptionFilter, Catch, ArgumentsHost, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { RateLimitInfo } from '../guards/rate-limit-throttler.guard';
import { I18nService } from '../../i18n/i18n.service';

/**
 * Custom exception filter for throttler exceptions.
 * Adds Retry-After and X-RateLimit-* headers to 429 responses.
 */
@Catch(ThrottlerException)
@Injectable()
export class ThrottlerExceptionFilter implements ExceptionFilter {
  constructor(private readonly i18n: I18nService) {}

  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { rateLimit?: RateLimitInfo; locale?: string }>();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();

    const rate = request.rateLimit;
    const reset = rate?.reset ?? 60;
    const limit = rate?.limit;
    const remaining = rate?.remaining ?? 0;

    const acceptLanguage = request.headers?.['accept-language'];
    const locale =
      request.locale ??
      this.i18n.resolveLocale(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage);
    const message = this.i18n.t('errors.TOO_MANY_REQUESTS', locale);

    response
      .status(status)
      .header('Retry-After', String(reset))
      .header('X-RateLimit-Limit', limit !== undefined ? String(limit) : '')
      .header('X-RateLimit-Remaining', String(remaining))
      .header('X-RateLimit-Reset', String(reset))
      .json({
        statusCode: status,
        message,
        error: 'ThrottlerException',
        retryAfter: `${reset}s`,
      });
  }
}
