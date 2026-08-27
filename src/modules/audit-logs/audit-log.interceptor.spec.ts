import { Test, TestingModule } from '@nestjs/testing';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { AuditLogService } from './audit-log.service';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

const mockAuditLogService = {
  record: jest.fn(),
};

describe('AuditLogInterceptor', () => {
  let interceptor: AuditLogInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogInterceptor,
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    interceptor = module.get<AuditLogInterceptor>(AuditLogInterceptor);
    jest.clearAllMocks();
  });

  describe('intercept()', () => {
    it('skips GET requests (read-only operations)', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'GET',
            path: '/api/v1/shipments',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
          }),
          getResponse: () => ({ statusCode: 200 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).not.toHaveBeenCalled();
    });

    it('records GET requests when using an impersonation token', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'GET',
            path: '/api/v1/shipments',
            user: {
              id: 'user-1',
              stellarAddress: 'GBUYER123',
              isImpersonation: true,
              impersonatorAdminId: 'admin-1',
              impersonatorAddress: 'GADMIN',
            },
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 200 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          actorAddress: 'GADMIN',
          action: 'impersonation.shipment.read',
          metadata: expect.objectContaining({
            impersonation: true,
            targetUserId: 'user-1',
            impersonatorAdminId: 'admin-1',
          }),
        }),
      );
    });

    it('skips HEAD and OPTIONS requests', async () => {
      for (const method of ['HEAD', 'OPTIONS']) {
        mockAuditLogService.record.mockClear();

        const mockContext = {
          switchToHttp: () => ({
            getRequest: () => ({
              method,
              path: '/api/v1/shipments',
              user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            }),
            getResponse: () => ({ statusCode: 200 }),
          }),
        } as unknown as ExecutionContext;

        const mockNext = {
          handle: () => of({}),
        } as unknown as CallHandler;

        await interceptor.intercept(mockContext, mockNext).toPromise();

        expect(mockAuditLogService.record).not.toHaveBeenCalled();
      }
    });

    it('records POST mutations with correct action and resource', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            path: '/api/v1/shipments',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            body: { shipmentId: 'SHIP-001' },
            headers: { 'x-forwarded-for': '192.168.1.1' },
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 201 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          actorAddress: 'GBUYER123',
          action: 'shipment.create',
          resourceType: 'Shipment',
          ipAddress: '192.168.1.1',
          metadata: expect.objectContaining({
            method: 'POST',
            statusCode: 201,
          }),
        }),
      );
    });

    it('records PATCH mutations with update action', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'PATCH',
            path: '/api/v1/shipments/SHIP-001',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            body: { description: 'Updated' },
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 200 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'shipment.update',
          resourceId: 'SHIP-001',
        }),
      );
    });

    it('records DELETE mutations', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'DELETE',
            path: '/api/v1/shipments/SHIP-001',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 204 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'shipment.delete',
        }),
      );
    });

    it('records POST with sub-action (e.g. /shipments/:id/sync)', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            path: '/api/v1/shipments/SHIP-001/sync',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 200 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'shipment.sync',
          resourceId: 'SHIP-001',
        }),
      );
    });

    it('does not record failed responses (non-2xx status)', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'PATCH',
            path: '/api/v1/shipments/SHIP-001',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 404 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).not.toHaveBeenCalled();
    });

    it('sanitizes sensitive fields from request body', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            path: '/api/v1/shipments',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            body: {
              shipmentId: 'SHIP-001',
              password: 'secret123',
              token: 'jwt-token',
              privateKey: 'key-data',
            },
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 201 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            requestBody: expect.objectContaining({
              shipmentId: 'SHIP-001',
              password: '[REDACTED]',
              token: '[REDACTED]',
              privateKey: '[REDACTED]',
            }),
          }),
        }),
      );
    });

    it('uses SYSTEM as actor for unauthenticated requests', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            path: '/api/v1/shipments',
            user: undefined,
            headers: {},
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 201 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: undefined,
          actorAddress: 'SYSTEM',
        }),
      );
    });

    it('extracts IP address from x-forwarded-for header', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            path: '/api/v1/shipments',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' },
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 201 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '192.168.1.1',
        }),
      );
    });

    it('falls back to x-real-ip header when x-forwarded-for not available', async () => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'POST',
            path: '/api/v1/shipments',
            user: { id: 'user-1', stellarAddress: 'GBUYER123' },
            headers: { 'x-real-ip': '10.0.0.1' },
            connection: { remoteAddress: '127.0.0.1' },
          }),
          getResponse: () => ({ statusCode: 201 }),
        }),
      } as unknown as ExecutionContext;

      const mockNext = {
        handle: () => of({}),
      } as unknown as CallHandler;

      await interceptor.intercept(mockContext, mockNext).toPromise();

      expect(mockAuditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '10.0.0.1',
        }),
      );
    });
  });
});
