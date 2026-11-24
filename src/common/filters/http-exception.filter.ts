import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { I18nService } from '../../i18n/i18n.service';

/** Standard error body shared by every error path (filter, body parser, ...). */
export function buildErrorBody(status: number, path: string, message: unknown) {
  return {
    success: false,
    statusCode: status,
    timestamp: new Date().toISOString(),
    path,
    message,
  };
}

/** Body-parser errors (e.g. entity.too.large) carry a numeric status/type. */
function statusFromRawError(exception: unknown): number | undefined {
  const err = exception as { status?: unknown; type?: unknown } | null;
  if (err?.type === 'entity.too.large') return HttpStatus.PAYLOAD_TOO_LARGE;
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) return err.status;
  return undefined;
}

@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // GraphQL has no HTTP response to write to here — hand the error back so
    // Apollo formats it (keeps extensions like code: 'TOO_MANY_REQUESTS').
    if (host.getType?.<string>() === 'graphql') {
      return exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : statusFromRawError(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;

    const rawMessage =
      exception instanceof HttpException
        ? exception.getResponse()
        : status === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'Request body too large'
          : status !== HttpStatus.INTERNAL_SERVER_ERROR && exception instanceof Error
            ? exception.message
            : 'Internal server error';

    const locale =
      request.locale ??
      this.i18n.resolveLocale(
        Array.isArray(request.headers['accept-language'])
          ? request.headers['accept-language'][0]
          : request.headers['accept-language'],
      );

    let message: unknown;
    if (typeof rawMessage === 'string') {
      message =
        status === HttpStatus.INTERNAL_SERVER_ERROR && rawMessage === 'Internal server error'
          ? this.i18n.t('errors.INTERNAL_SERVER_ERROR', locale)
          : this.i18n.translateErrorMessage(rawMessage, locale);
    } else if (rawMessage && typeof rawMessage === 'object') {
      message = this.i18n.translateErrorMessage(rawMessage, locale);
    } else {
      message = rawMessage;
    }

    const errorResponse = buildErrorBody(status, request.url, message);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(errorResponse);
  }
}
