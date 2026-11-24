import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { I18nService } from '../../i18n/i18n.service';
import { ThrottlerExceptionFilter } from './throttler-exception.filter';

function createHost(request: Record<string, unknown>) {
  const response = {
    status: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('ThrottlerExceptionFilter', () => {
  const filter = new ThrottlerExceptionFilter(new I18nService());

  it('returns 429 with Retry-After and X-RateLimit-* headers from request.rateLimit', () => {
    const { host, response } = createHost({
      headers: {},
      rateLimit: { limit: 100, remaining: 0, reset: 42 },
    });

    filter.catch(new ThrottlerException(), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(response.header).toHaveBeenCalledWith('Retry-After', '42');
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Reset', '42');
    expect(response.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too Many Requests',
      error: 'ThrottlerException',
      retryAfter: '42s',
    });
  });

  it('falls back to defaults when no rate-limit metadata is attached', () => {
    const { host, response } = createHost({ headers: {} });

    filter.catch(new ThrottlerException(), host);

    expect(response.header).toHaveBeenCalledWith('Retry-After', '60');
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Reset', '60');
  });

  it('localizes the message from Accept-Language', () => {
    const { host, response } = createHost({
      headers: { 'accept-language': 'es-ES,es;q=0.9' },
      rateLimit: { limit: 10, remaining: 0, reset: 5 },
    });

    filter.catch(new ThrottlerException(), host);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Demasiadas solicitudes' }),
    );
  });

  it('prefers the locale resolved by LocaleMiddleware', () => {
    const { host, response } = createHost({
      headers: { 'accept-language': 'en' },
      locale: 'es',
    });

    filter.catch(new ThrottlerException(), host);

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Demasiadas solicitudes' }),
    );
  });
});
