import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { RateLimitInfo } from '../guards/rate-limit-throttler.guard';

/**
 * Custom exception filter for throttler exceptions.
 * Adds Retry-After and X-RateLimit-* headers to 429 responses.
 */
@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { rateLimit?: RateLimitInfo }>();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const rate = request.rateLimit;
    const reset = rate?.reset ?? 60;
    const limit = rate?.limit;
    const remaining = rate?.remaining ?? 0;

    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as { message?: string })?.message || 'Too Many Requests';

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
