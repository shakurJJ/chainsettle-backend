import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { UserRole } from '@prisma/client';

/**
 * Shape of `request.user` as populated by the JWT and API-key strategies.
 */
export interface AuthenticatedUser {
  id: string;
  stellarAddress: string;
  role: UserRole;
  /** Admin user ID when the token was issued via impersonation */
  impersonatedBy?: string;
  /** API key ID when the request was authenticated with an API key */
  apiKeyId?: string;
  /** Raw JWT subject — legacy fallback for stellarAddress in some handlers */
  sub?: string;
  /** JWT ID, present for JWT-authenticated sessions */
  jti?: string;
  /** JWT expiry (seconds since epoch) */
  exp?: number;
  /** Scopes granted to the API key, present only for API-key auth */
  _apiKeyScopes?: string[];
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    // GraphQL resolvers receive (root, args, context, info) — the request
    // lives on the GraphQL context rather than the first handler argument.
    const request =
      ctx.getType<string>() === 'graphql'
        ? GqlExecutionContext.create(ctx).getContext().req
        : ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request?.user;
    return data ? user?.[data] : user;
  },
);
