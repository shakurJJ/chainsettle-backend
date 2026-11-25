import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { I18nService } from '../../i18n/i18n.service';
import {
  HttpExceptionFilter,
  buildErrorBody,
  isStatementTimeout,
  PROBLEM_JSON,
  DB_STATEMENT_TIMEOUT_CODE,
} from './http-exception.filter';

function createHost(request: Record<string, unknown>) {
  // The filter writes `res.status(s).type(PROBLEM_JSON).send(JSON.stringify(body))`;
  // `json` receives the parsed body so assertions can inspect it directly.
  const response: Record<string, jest.Mock> = {
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  response.send = jest.fn((payload: string) => {
    response.json(JSON.parse(payload));
    return response;
  });
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('buildErrorBody', () => {
  it('returns standardized error structure', () => {
    const result = buildErrorBody(400, '/api/shipments', 'Invalid request');

    expect(result).toEqual({
      type: 'https://chainsettle.dev/problems/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'Invalid request',
      instance: '/api/shipments',
      code: 'BAD_REQUEST',
      success: false,
      statusCode: 400,
      timestamp: expect.any(String),
      path: '/api/shipments',
      message: 'Invalid request',
    });
    expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('accepts complex message objects', () => {
    const message = { i18nKey: 'errors.SHIPMENT_NOT_FOUND', args: { id: '123' } };
    const result = buildErrorBody(404, '/api/shipments/123', message);

    expect(result.message).toEqual(message);
  });

  it('prefers an explicit code, then a code on the message, then the status name', () => {
    expect(buildErrorBody(503, '/x', 'timeout', 'DB_STATEMENT_TIMEOUT').code).toBe('DB_STATEMENT_TIMEOUT');
    expect(buildErrorBody(409, '/x', { code: 'SHIPMENT_EXISTS', message: 'dup' }).code).toBe('SHIPMENT_EXISTS');
    expect(buildErrorBody(404, '/x', 'gone').code).toBe('NOT_FOUND');
  });

  it('derives detail from string, array and nested message', () => {
    expect(buildErrorBody(400, '/x', ['a is required', 'b is required']).detail).toBe(
      'a is required; b is required',
    );
    expect(buildErrorBody(400, '/x', { message: 'Validation failed' }).detail).toBe('Validation failed');
    expect(buildErrorBody(400, '/x', undefined).detail).toBe('');
  });

  it('builds a kebab-case problem type URI from the code', () => {
    expect(buildErrorBody(429, '/x', 'slow down').type).toBe(
      'https://chainsettle.dev/problems/too-many-requests',
    );
  });
});

describe('isStatementTimeout', () => {
  it('detects SQLSTATE 57014 and the Postgres cancel message', () => {
    expect(isStatementTimeout({ code: '57014' })).toBe(true);
    expect(isStatementTimeout({ meta: { code: '57014' } })).toBe(true);
    expect(isStatementTimeout(new Error('ERROR: canceling statement due to statement timeout'))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isStatementTimeout(null)).toBe(false);
    expect(isStatementTimeout(new Error('connection refused'))).toBe(false);
    expect(isStatementTimeout({ code: 'P2002' })).toBe(false);
  });
});

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let i18nService: I18nService;

  beforeEach(() => {
    i18nService = new I18nService();
    filter = new HttpExceptionFilter(i18nService);
  });

  describe('HttpException handling', () => {
    it('extracts status and message from HttpException', () => {
      const { host, response } = createHost({
        url: '/api/shipments',
        headers: {},
      });

      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(response.json).toHaveBeenCalledWith({
        type: 'https://chainsettle.dev/problems/not-found',
        title: 'Not Found',
        status: 404,
        detail: 'Not Found',
        instance: '/api/shipments',
        code: 'NOT_FOUND',
        success: false,
        statusCode: 404,
        timestamp: expect.any(String),
        path: '/api/shipments',
        message: 'Not Found',
      });
    });

    it('handles HttpException with object response', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new HttpException(
        { message: 'Validation failed', errors: ['field1', 'field2'] },
        HttpStatus.BAD_REQUEST,
      );
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(response.json).toHaveBeenCalledWith({
        type: 'https://chainsettle.dev/problems/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: 'Validation failed',
        instance: '/api/test',
        code: 'BAD_REQUEST',
        success: false,
        statusCode: 400,
        timestamp: expect.any(String),
        path: '/api/test',
        // Translation reduces an object response to its message.
        message: 'Validation failed',
      });
    });
  });

  describe('problem+json response', () => {
    it('sends the body as application/problem+json', () => {
      const { host, response } = createHost({ url: '/api/shipments', headers: {} });

      filter.catch(new HttpException('Not Found', HttpStatus.NOT_FOUND), host);

      expect(response.type).toHaveBeenCalledWith(PROBLEM_JSON);
      expect(response.send).toHaveBeenCalledTimes(1);
    });

    it('preserves an error code supplied by the exception', () => {
      const { host, response } = createHost({ url: '/api/shipments', headers: {} });

      filter.catch(
        new HttpException({ code: 'SHIPMENT_NOT_FOUND', message: 'Shipment not found' }, HttpStatus.NOT_FOUND),
        host,
      );

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 404,
          code: 'SHIPMENT_NOT_FOUND',
          type: 'https://chainsettle.dev/problems/shipment-not-found',
        }),
      );
    });
  });

  describe('statement timeout handling', () => {
    it('maps a Postgres statement timeout to 503 DB_STATEMENT_TIMEOUT', () => {
      const { host, response } = createHost({ url: '/api/shipments/export', method: 'GET', headers: {} });

      filter.catch(new Error('canceling statement due to statement timeout'), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 503,
          statusCode: 503,
          code: DB_STATEMENT_TIMEOUT_CODE,
          title: 'Service Unavailable',
          instance: '/api/shipments/export',
        }),
      );
    });

    it('maps a Prisma error carrying SQLSTATE 57014 to 503', () => {
      const { host, response } = createHost({ url: '/api/search', method: 'GET', headers: {} });

      filter.catch({ code: '57014', message: 'query cancelled' }, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: DB_STATEMENT_TIMEOUT_CODE }),
      );
    });
  });

  describe('Non-HTTP exception handling', () => {
    it('handles unknown errors as 500 Internal Server Error', () => {
      const { host, response } = createHost({
        url: '/api/broken',
        headers: {},
      });

      const exception = new Error('Database connection failed');
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response.json).toHaveBeenCalledWith({
        type: 'https://chainsettle.dev/problems/internal-server-error',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Internal server error',
        instance: '/api/broken',
        code: 'INTERNAL_SERVER_ERROR',
        success: false,
        statusCode: 500,
        timestamp: expect.any(String),
        path: '/api/broken',
        message: 'Internal server error',
      });
    });

    it('handles entity.too.large as 413 Payload Too Large', () => {
      const { host, response } = createHost({
        url: '/api/upload',
        headers: {},
      });

      const exception = { type: 'entity.too.large', status: 413 };
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(response.json).toHaveBeenCalledWith({
        type: 'https://chainsettle.dev/problems/payload-too-large',
        title: 'Payload Too Large',
        status: 413,
        detail: 'Request body too large',
        instance: '/api/upload',
        code: 'PAYLOAD_TOO_LARGE',
        success: false,
        statusCode: 413,
        timestamp: expect.any(String),
        path: '/api/upload',
        message: 'Request body too large',
      });
    });

    it('extracts status from raw error with numeric status', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new Error('Client error') as Error & { status: number };
      exception.status = 400;
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(400);
    });

    it('ignores invalid status codes from raw errors', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new Error('Invalid status') as Error & { status: number };
      exception.status = 600; // invalid status code
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  describe('Internationalization', () => {
    it('translates error messages using i18nKey payload', () => {
      const { host, response } = createHost({
        url: '/api/shipments/123',
        headers: { 'accept-language': 'es' },
      });

      const exception = new HttpException(
        { i18nKey: 'errors.SHIPMENT_NOT_FOUND', args: { id: '123' } },
        HttpStatus.NOT_FOUND,
      );
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Envío 123 no encontrado',
        }),
      );
    });

    it('translates error messages by matching English text', () => {
      const { host, response } = createHost({
        url: '/api/shipments',
        headers: { 'accept-language': 'es-ES,es;q=0.9' },
      });

      const exception = new HttpException(
        'Only the shipment buyer may confirm milestones',
        HttpStatus.FORBIDDEN,
      );
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Solo el comprador del envío puede confirmar hitos',
        }),
      );
    });

    it('prefers locale resolved by LocaleMiddleware', () => {
      const { host, response } = createHost({
        url: '/api/shipments',
        headers: { 'accept-language': 'en' },
        locale: 'es',
      });

      const exception = new HttpException(
        'Internal server error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Error interno del servidor',
        }),
      );
    });

    it('falls back to English when locale is unsupported', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: { 'accept-language': 'de-DE' },
      });

      const exception = new HttpException('Internal server error', HttpStatus.INTERNAL_SERVER_ERROR);
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Internal server error',
        }),
      );
    });

    it('translates array of error messages', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: { 'accept-language': 'es' },
      });

      const exception = new HttpException(
        {
          message: [
            'Only the shipment buyer may confirm milestones',
            'Milestone not found',
          ],
        },
        HttpStatus.BAD_REQUEST,
      );
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: [
            'Solo el comprador del envío puede confirmar hitos',
            'Milestone not found',
          ],
          detail: 'Solo el comprador del envío puede confirmar hitos; Milestone not found',
        }),
      );
    });

    it('handles nested message objects', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: { 'accept-language': 'es' },
      });

      const exception = new HttpException(
        { message: 'Internal server error' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Error interno del servidor',
          detail: 'Error interno del servidor',
        }),
      );
    });

    it('translates INTERNAL_SERVER_ERROR key with locale', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: { 'accept-language': 'es' },
      });

      const exception = new HttpException('Internal server error', HttpStatus.INTERNAL_SERVER_ERROR);
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Error interno del servidor',
        }),
      );
    });

    it('uses default locale when Accept-Language header is missing', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new HttpException('Internal server error', HttpStatus.INTERNAL_SERVER_ERROR);
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Internal server error',
        }),
      );
    });

    it('handles Accept-Language as array', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: { 'accept-language': ['es', 'en'] },
      });

      const exception = new HttpException('Internal server error', HttpStatus.INTERNAL_SERVER_ERROR);
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Error interno del servidor',
        }),
      );
    });
  });

  describe('Logging', () => {
    it('logs 500 errors with stack trace', () => {
      const loggerSpy = jest.spyOn(filter['logger'], 'error');
      const { host } = createHost({
        url: '/api/broken',
        method: 'POST',
        headers: {},
      });

      const exception = new Error('Database connection failed');
      filter.catch(exception, host);

      expect(loggerSpy).toHaveBeenCalledWith(
        'POST /api/broken',
        expect.stringContaining('Database connection failed'),
      );
    });

    it('does not log non-500 errors', () => {
      const loggerSpy = jest.spyOn(filter['logger'], 'error');
      const { host } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);
      filter.catch(exception, host);

      expect(loggerSpy).not.toHaveBeenCalled();
    });

    it('logs non-Error objects as strings', () => {
      const loggerSpy = jest.spyOn(filter['logger'], 'error');
      const { host } = createHost({
        url: '/api/test',
        method: 'GET',
        headers: {},
      });

      const exception = { message: 'Something went wrong' };
      filter.catch(exception, host);

      expect(loggerSpy).toHaveBeenCalledWith(
        'GET /api/test',
        '[object Object]',
      );
    });
  });

  describe('Edge cases', () => {
    it('handles exception with no message', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new HttpException(null as any, HttpStatus.BAD_REQUEST);
      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: null }),
      );
    });

    it('handles non-string, non-object messages', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: {},
      });

      const exception = new HttpException(12345 as any, HttpStatus.BAD_REQUEST);
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 12345 }),
      );
    });

    it('preserves original message when no translation exists', () => {
      const { host, response } = createHost({
        url: '/api/test',
        headers: { 'accept-language': 'es' },
      });

      const customMessage = 'This is a custom error without translation';
      const exception = new HttpException(customMessage, HttpStatus.BAD_REQUEST);
      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: customMessage }),
      );
    });
  });
});
