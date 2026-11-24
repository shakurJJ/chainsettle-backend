import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response, NextFunction } from 'express';
import { RequestIdMiddleware, requestIdStorage } from './request-id.middleware';

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RequestIdMiddleware],
    }).compile();

    middleware = module.get<RequestIdMiddleware>(RequestIdMiddleware);
  });

  const createMockReqRes = (headers: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction } => {
    const req = {
      headers,
    } as unknown as Request;
    
    const res = {
      setHeader: jest.fn(),
    } as unknown as Response;
    
    const next = jest.fn();
    
    return { req, res, next };
  };

  describe('when X-Request-ID header is provided', () => {
    it('should preserve the incoming X-Request-ID', () => {
      const customRequestId = 'custom-request-id-12345';
      const { req, res, next } = createMockReqRes({ 'x-request-id': customRequestId });

      middleware.use(req, res, next);

      expect((req as any).id).toBe(customRequestId);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', customRequestId);
      expect(next).toHaveBeenCalled();
    });

    it('should preserve very long request IDs (up to reasonable limit)', () => {
      const longRequestId = 'a'.repeat(200);
      const { req, res, next } = createMockReqRes({ 'x-request-id': longRequestId });

      middleware.use(req, res, next);

      expect((req as any).id).toBe(longRequestId);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('when X-Request-ID header is missing', () => {
    it('should generate a new UUID', () => {
      const { req, res, next } = createMockReqRes();

      middleware.use(req, res, next);

      expect((req as any).id).toBeDefined();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect((req as any).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(res.setHeader).toHaveBeenCalled();
    });
  });

  describe('response header', () => {
    it('should set X-Request-ID header on response', () => {
      const { req, res, next } = createMockReqRes();

      middleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', (req as any).id);
    });
  });

  describe('invalid ID handling', () => {
    it('should replace empty string X-Request-ID with generated UUID', () => {
      const { req, res, next } = createMockReqRes({ 'x-request-id': '' });

      middleware.use(req, res, next);

      expect((req as any).id).toBeDefined();
      expect((req as any).id).not.toBe('');
    });

    it('should replace whitespace-only X-Request-ID with generated UUID', () => {
      const { req, res, next } = createMockReqRes({ 'x-request-id': '   ' });

      middleware.use(req, res, next);

      expect((req as any).id).toBeDefined();
      // Whitespace should be trimmed or replaced
      expect((req as any).id.trim()).toBe((req as any).id);
    });
  });

  describe('AsyncLocalStorage', () => {
    it('should run the next function within the request ID context', () => {
      let capturedRequestId: string | undefined;
      const { req, res, next } = createMockReqRes();

      const wrappedNext = () => {
        capturedRequestId = requestIdStorage.getStore();
        next();
      };

      middleware.use(req, res, wrappedNext);

      expect(capturedRequestId).toBe((req as any).id);
      expect(next).toHaveBeenCalled();
    });
  });
});