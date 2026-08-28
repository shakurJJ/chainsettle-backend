import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { DEPRECATION_KEY, DeprecationMeta } from '../decorators/deprecated.decorator';

/**
 * Adds RFC 8594-style Deprecation / Sunset headers when a handler
 * is annotated with @DeprecatedRoute(...).
 */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const meta = this.reflector.getAllAndOverride<DeprecationMeta | undefined>(
      DEPRECATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (meta) {
      const res = context.switchToHttp().getResponse();
      res.setHeader('Deprecation', meta.deprecation ?? 'true');
      if (meta.sunset) {
        res.setHeader('Sunset', meta.sunset);
      }
      if (meta.link) {
        res.setHeader('Link', `<${meta.link}>; rel="deprecation"; type="text/html"`);
      }
    }

    return next.handle();
  }
}
