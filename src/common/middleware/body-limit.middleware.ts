import { HttpStatus } from '@nestjs/common';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { buildErrorBody } from '../filters/http-exception.filter';

/** Default JSON body limit applied to every route (#433). */
export const DEFAULT_BODY_LIMIT = '100kb';

/** Default maximum JSON nesting depth (#433). */
export const DEFAULT_MAX_JSON_DEPTH = 20;

export interface BodyLimitRoute {
  /** HTTP method, or '*' for any. */
  method: string;
  /** Matched against the request path (prefix/version included). */
  pattern: RegExp;
  limit: string;
}

/**
 * Routes that legitimately need bigger payloads. Everything else gets
 * DEFAULT_BODY_LIMIT. Add an entry here instead of raising the global limit.
 */
export const BODY_LIMIT_ROUTES: BodyLimitRoute[] = [
  { method: 'POST', pattern: /\/shipments\/import\/?$/, limit: '5mb' },
  { method: 'POST', pattern: /\/shipments\/[^/]+\/metadata\/validate\/?$/, limit: '5mb' },
  { method: 'PATCH', pattern: /\/shipments\/[^/]+\/?$/, limit: '5mb' },
  { method: 'POST', pattern: /\/shipments\/?$/, limit: '5mb' },
];

export function resolveBodyLimit(
  method: string,
  path: string,
  routes: BodyLimitRoute[] = BODY_LIMIT_ROUTES,
  fallback: string = DEFAULT_BODY_LIMIT,
): string {
  const match = routes.find(
    (r) => (r.method === '*' || r.method === method.toUpperCase()) && r.pattern.test(path),
  );
  return match?.limit ?? fallback;
}

/** Returns the nesting depth of a parsed JSON value (scalars are depth 0). */
export function jsonDepth(value: unknown, max = Infinity): number {
  let deepest = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    const d = depth + 1;
    if (d > deepest) deepest = d;
    if (deepest > max) return deepest;
    for (const child of Object.values(node as object)) stack.push([child, d]);
  }
  return deepest;
}

interface BodyLimitOptions {
  routes?: BodyLimitRoute[];
  defaultLimit?: string;
  maxDepth?: number;
}

/**
 * Replaces Nest's global body parser with per-route limits, a JSON nesting
 * depth guard and error responses in the standard filter format.
 * The raw body is kept on `req.rawBody` for signature-verified webhooks.
 */
export function createBodyLimitMiddleware(options: BodyLimitOptions = {}): RequestHandler {
  const routes = options.routes ?? BODY_LIMIT_ROUTES;
  const defaultLimit = options.defaultLimit ?? DEFAULT_BODY_LIMIT;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const parsers = new Map<string, RequestHandler[]>();
  const verify = (req: any, _res: unknown, buf: Buffer) => {
    req.rawBody = buf;
  };

  const parsersFor = (limit: string) => {
    let p = parsers.get(limit);
    if (!p) {
      p = [json({ limit, verify }), urlencoded({ limit, extended: true, verify })];
      parsers.set(limit, p);
    }
    return p;
  };

  const sendError = (req: Request, res: Response, status: number, message: string) =>
    res.status(status).json(buildErrorBody(status, req.originalUrl ?? req.url, message));

  return (req: Request, res: Response, next: NextFunction) => {
    const limit = resolveBodyLimit(req.method, req.path, routes, defaultLimit);
    const [jsonParser, urlParser] = parsersFor(limit);

    const onParsed = (err?: any) => {
      if (err) {
        if (err.type === 'entity.too.large' || err.status === HttpStatus.PAYLOAD_TOO_LARGE) {
          return sendError(req, res, HttpStatus.PAYLOAD_TOO_LARGE, `Request body exceeds the ${limit} limit`);
        }
        return sendError(req, res, err.status ?? HttpStatus.BAD_REQUEST, err.message ?? 'Invalid request body');
      }
      if (req.body && typeof req.body === 'object' && jsonDepth(req.body, maxDepth) > maxDepth) {
        return sendError(req, res, HttpStatus.BAD_REQUEST, `JSON nesting depth exceeds ${maxDepth}`);
      }
      next();
    };

    jsonParser(req, res, (err?: any) => (err ? onParsed(err) : urlParser(req, res, onParsed)));
  };
}
