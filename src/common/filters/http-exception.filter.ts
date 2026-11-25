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

export const PROBLEM_JSON = 'application/problem+json';
export const DB_STATEMENT_TIMEOUT_CODE = 'DB_STATEMENT_TIMEOUT';

/** Stable machine-readable code for a status when the exception carries none. */
function defaultCode(status: number): string {
  return (HttpStatus[status] as string | undefined) ?? `HTTP_${status}`;
}

function titleFor(status: number): string {
  return defaultCode(status)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function detailFrom(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  const m = (message as { message?: unknown } | null)?.message;
  if (m !== undefined) return detailFrom(m);
  return '';
}

/**
 * Standard error body shared by every error path (filter, body parser, ...).
 * Emits RFC 9457 problem details (type, title, status, detail, instance, code)
 * plus the legacy fields (success, statusCode, timestamp, path, message) as
 * extension members so existing clients keep working during migration.
 */
export function buildErrorBody(status: number, path: string, message: unknown, code?: string) {
  const resolvedCode =
    code ??
    ((message as { code?: unknown } | null)?.code as string | undefined) ??
    defaultCode(status);
  return {
    type: `https://chainsettle.dev/problems/${resolvedCode.toLowerCase().replace(/_/g, '-')}`,
    title: titleFor(status),
    status,
    detail: detailFrom(message),
    instance: path,
    code: resolvedCode,
    success: false,
    statusCode: status,
    timestamp: new Date().toISOString(),
    path,
    message,
  };
}

/** Postgres SQLSTATE 57014 — query cancelled by statement_timeout. */
export function isStatementTimeout(exception: unknown): boolean {
  const err = exception as { code?: unknown; message?: unknown; meta?: { code?: unknown } } | null;
  if (!err) return false;
  if (err.code === '57014' || err.meta?.code === '57014') return true;
  return typeof err.message === 'string' && /canceling statement due to statement timeout/i.test(err.message);
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

    const timedOut = !(exception instanceof HttpException) && isStatementTimeout(exception);

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : timedOut
          ? HttpStatus.SERVICE_UNAVAILABLE
          : statusFromRawError(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;

    const rawMessage =
      exception instanceof HttpException
        ? exception.getResponse()
        : timedOut
          ? 'Database query timed out, please retry or narrow the request'
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

    // Read the code before translation, which can reduce an object response
    // to just its message and would otherwise drop the code.
    const exceptionCode = (rawMessage as { code?: unknown } | null)?.code;
    const errorResponse = buildErrorBody(
      status,
      request.url,
      message,
      timedOut
        ? DB_STATEMENT_TIMEOUT_CODE
        : typeof exceptionCode === 'string'
          ? exceptionCode
          : undefined,
    );

    if (timedOut) {
      this.logger.warn(`${request.method} ${request.url} cancelled by statement timeout`);
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).type(PROBLEM_JSON).send(JSON.stringify(errorResponse));
  }
}
