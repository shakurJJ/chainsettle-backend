import {
  Injectable,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** HTTP methods that require the "write" scope on an API key. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * ApiKeyGuard
 *
 * Authenticates the request via the `x-api-key` header (passport-custom
 * strategy) and then enforces scope-based access control:
 *
 *   - Keys with `scopes: ["read", "write"]` (default) may call any endpoint.
 *   - Keys with `scopes: ["read"]` only may call GET and HEAD endpoints.
 *     Any mutating method (POST/PUT/PATCH/DELETE) is rejected with
 *     403 `API_KEY_SCOPE_INSUFFICIENT`.
 *
 * JWT-authenticated requests bypass this guard entirely — scopes are an
 * API-key-only concept.
 */
@Injectable()
export class ApiKeyGuard extends AuthGuard('api-key') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  /**
   * Called by Passport after the strategy's validate() resolves successfully.
   * `user` is the object returned by ApiKeyStrategy.validate(), which includes
   * the `_apiKeyScopes` field injected by the strategy.
   */
  handleRequest<TUser extends { _apiKeyScopes?: string[] }>(
    err: Error | null,
    user: TUser | false,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    // Let the parent handle auth errors (missing header, invalid key, expired, etc.)
    if (err || !user) {
      throw err || new ForbiddenException('API key authentication failed');
    }

    const req = context.switchToHttp().getRequest<{ method: string }>();
    const method = req.method.toUpperCase();

    if (WRITE_METHODS.has(method)) {
      const scopes: string[] = user._apiKeyScopes ?? ['read', 'write'];
      if (!scopes.includes('write')) {
        throw new ForbiddenException('API_KEY_SCOPE_INSUFFICIENT');
      }
    }

    return user;
  }
}
