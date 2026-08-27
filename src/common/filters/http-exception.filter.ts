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

@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawMessage =
      exception instanceof HttpException
        ? exception.getResponse()
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

    const errorResponse = {
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    };

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(errorResponse);
  }
}
