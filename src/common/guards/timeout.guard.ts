import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TIMEOUT_KEY } from '../decorators/timeout.decorator';

/**
 * Guard that reads the @Timeout() decorator and sets the timeout value
 * on the request object for the TimeoutInterceptor to use.
 */
@Injectable()
export class TimeoutGuard implements CanActivate {
  private readonly logger = new Logger(TimeoutGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const timeoutMs = this.reflector.get<number>(TIMEOUT_KEY, context.getHandler());
    
    if (timeoutMs) {
      const request = context.switchToHttp().getRequest();
      (request as any).timeoutMs = timeoutMs;
      this.logger.debug(`Timeout set to ${timeoutMs}ms for ${request.method} ${request.url}`);
    }
    
    return true;
  }
}