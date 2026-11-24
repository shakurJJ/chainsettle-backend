import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Maximum allowed length for X-Request-ID header to prevent abuse.
 */
const MAX_REQUEST_ID_LENGTH = 500;

/**
 * Determines if a request ID is valid.
 * Invalid IDs are empty, whitespace-only, or exceed the maximum length.
 */
function isValidRequestId(id: string | undefined): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_REQUEST_ID_LENGTH) return false;
  return true;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incomingId = req.headers['x-request-id'] as string;
    
    // Use incoming ID if valid, otherwise generate a new one
    const requestId = isValidRequestId(incomingId) 
      ? incomingId.trim() 
      : randomUUID();

    (req as any).id = requestId;
    res.setHeader('X-Request-ID', requestId);

    requestIdStorage.run(requestId, () => next());
  }
}