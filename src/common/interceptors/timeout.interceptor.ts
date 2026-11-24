import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
  Logger,
} from '@nestjs/common';
import { Observable, timeout, catchError, throwError } from 'rxjs';
import { ConfigService } from '@nestjs/config';

/**
 * Interceptor that adds a timeout to HTTP requests.
 * Returns 503 Service Unavailable if the request exceeds the timeout.
 * 
 * Use @Timeout() decorator to override the default timeout for specific routes.
 * 
 * @example
 * // Default timeout (30 seconds)
 * @Get('normal-endpoint')
 * normalRoute() { ... }
 * 
 * @example
 * // Extended timeout for exports (5 minutes)
 * @Timeout(300000)
 * @Get('export')
 * exportRoute() { ... }
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimeoutInterceptor.name);
  private readonly defaultTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.defaultTimeoutMs = this.config.get<number>('REQUEST_TIMEOUT_MS', 30000);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    
    // Get timeout from request (set by @Timeout decorator) or use default
    const timeoutMs = (request as any).timeoutMs || this.defaultTimeoutMs;
    
    return next.handle().pipe(
      timeout(timeoutMs),
      catchError((err) => {
        if (err.name === 'TimeoutError') {
          this.logger.warn(
            `Request timeout after ${timeoutMs}ms: ${request.method} ${request.url}`,
          );
          return throwError(() => new RequestTimeoutException({
            statusCode: 503,
            message: 'Request timeout - the server took too long to respond',
            error: 'Service Unavailable',
          }));
        }
        return throwError(() => err);
      }),
    );
  }
}