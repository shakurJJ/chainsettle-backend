import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { AuditLogService } from './audit-log.service';

/**
 * AuditLogInterceptor
 *
 * Automatically records all successful POST, PATCH, DELETE mutations.
 * Additionally, EVERY request made with an impersonation token is logged
 * (including GETs) so support sessions are fully traceable.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(private readonly auditLog: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    const method = request.method;
    const path = request.path;
    const user = request.user; // Set by JwtAuthGuard

    const isImpersonation = !!user?.isImpersonation;
    const isMutation =
      method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    // Skip non-mutations unless this is an impersonation session
    if (!isMutation && !isImpersonation) {
      return next.handle();
    }

    // Extract actor information — for impersonation, actor is the admin
    const actorId = isImpersonation ? user.impersonatorAdminId : user?.id;
    const actorAddress = isImpersonation
      ? (user.impersonatorAddress ?? 'SYSTEM')
      : (user?.stellarAddress ?? 'SYSTEM');

    const { action, resourceType, resourceId } = this.deriveActionAndResource(
      method,
      path,
      request,
    );

    return next.handle().pipe(
      tap(() => {
        const statusCode = context.switchToHttp().getResponse().statusCode;
        if (statusCode >= 200 && statusCode < 300) {
          this.auditLog.record({
            actorId,
            actorAddress,
            action: isImpersonation ? `impersonation.${action}` : action,
            resourceType,
            resourceId,
            metadata: {
              method,
              path,
              statusCode,
              ...(request.body && { requestBody: this.sanitizeBody(request.body) }),
              ...(isImpersonation && {
                impersonation: true,
                targetUserId: user.id,
                targetStellarAddress: user.stellarAddress,
                impersonatorAdminId: user.impersonatorAdminId,
                impersonatorAddress: user.impersonatorAddress,
              }),
            },
            ipAddress: this.getClientIp(request),
          });
        }
      }),
      catchError((error) => {
        throw error;
      }),
    );
  }

  private deriveActionAndResource(
    method: string,
    path: string,
    _request: any,
  ): { action: string; resourceType: string; resourceId: string } {
    const segments = path.split('/').filter((s) => s.length > 0);

    // Format: /api/v1/{resourceType}/{resourceId}/{subresource}
    // After versioning: segments[0]=api, segments[1]=v1, segments[2]=resource
    let resourceType = 'Unknown';
    let resourceId = 'unknown-id';
    let subAction = '';

    // Find the index after the version segment (v1, v2, ...)
    let resourceIdx = 1;
    if (segments[0] === 'api' && /^v\d+$/.test(segments[1] ?? '')) {
      resourceIdx = 2;
    } else if (segments[0] === 'api') {
      resourceIdx = 1;
    }

    if (segments.length > resourceIdx) {
      const raw = segments[resourceIdx];
      resourceType = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/s$/, '');
    }

    if (segments.length > resourceIdx + 1) {
      resourceId = segments[resourceIdx + 1];
      if (segments.length > resourceIdx + 2) {
        subAction = segments[resourceIdx + 2];
      }
    }

    let action = `${resourceType.toLowerCase()}.create`;
    if (method === 'GET' || method === 'HEAD') {
      action = `${resourceType.toLowerCase()}.read`;
    } else if (method === 'PATCH' || method === 'PUT') {
      action = `${resourceType.toLowerCase()}.update`;
    } else if (method === 'DELETE') {
      action = `${resourceType.toLowerCase()}.delete`;
    } else if (method === 'POST' && subAction) {
      action = `${resourceType.toLowerCase()}.${subAction}`;
    }

    return { action, resourceType, resourceId };
  }

  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;

    const sanitized = { ...body };
    const sensitiveFields = [
      'password',
      'token',
      'secret',
      'privateKey',
      'seed',
      'mnemonic',
      'accessToken',
    ];

    sensitiveFields.forEach((field) => {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    });

    return sanitized;
  }

  private getClientIp(request: any): string | undefined {
    return (
      request.headers['x-forwarded-for']?.split(',')[0] ||
      request.headers['x-real-ip'] ||
      request.connection?.remoteAddress ||
      undefined
    );
  }
}
