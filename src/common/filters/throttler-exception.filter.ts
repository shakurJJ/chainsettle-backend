import { ExceptionFilter, Catch, ArgumentsHost, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { I18nService } from '../../i18n/i18n.service';

/**
 * Custom exception filter for throttler exceptions
 * Adds Retry-After header to 429 responses
 */
@Catch(ThrottlerException)
@Injectable()
export class ThrottlerExceptionFilter implements ExceptionFilter {
  constructor(private readonly i18n: I18nService) {}

  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse() as any;

    // Calculate retry-after in seconds (default to 60 if not available)
    const retryAfter = Math.ceil((exceptionResponse.ttl || 60000) / 1000);
    const locale =
      request.locale ??
      this.i18n.resolveLocale(
        Array.isArray(request.headers['accept-language'])
          ? request.headers['accept-language'][0]
          : request.headers['accept-language'],
      );

    response
      .status(status)
      .header('Retry-After', retryAfter.toString())
      .json({
        statusCode: status,
        message: this.i18n.t('errors.TOO_MANY_REQUESTS', locale),
        error: 'ThrottlerException',
        retryAfter: `${retryAfter}s`,
      });
  }
}
