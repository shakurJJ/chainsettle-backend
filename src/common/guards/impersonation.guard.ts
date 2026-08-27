import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BLOCK_IMPERSONATION_KEY } from '../decorators/block-impersonation.decorator';

/**
 * Rejects requests made with an impersonation JWT when the handler
 * (or controller) is marked @BlockImpersonation().
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const blocked = this.reflector.getAllAndOverride<boolean>(
      BLOCK_IMPERSONATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!blocked) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    if (request.user?.isImpersonation) {
      throw new ForbiddenException(
        'This action is not allowed while impersonating another user',
      );
    }

    return true;
  }
}
