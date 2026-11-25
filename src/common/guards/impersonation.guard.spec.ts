import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ImpersonationGuard } from './impersonation.guard';
import { BLOCK_IMPERSONATION_KEY } from '../decorators/block-impersonation.decorator';

describe('ImpersonationGuard', () => {
  let guard: ImpersonationGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;

  const createContext = (user?: any): ExecutionContext => {
    const handler = jest.fn();
    const cls = class TestController {};

    return {
      getHandler: jest.fn().mockReturnValue(handler),
      getClass: jest.fn().mockReturnValue(cls),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({ user }),
        getResponse: jest.fn().mockReturnValue({}),
        getNext: jest.fn(),
      }),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn(),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };
    guard = new ImpersonationGuard(reflector as unknown as Reflector);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when handler is not blocked', () => {
    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(false);
    });

    it('allows access for a regular user', () => {
      const context = createContext({ id: 'user-1', isImpersonation: false });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access for an impersonating user', () => {
      const context = createContext({ id: 'user-1', isImpersonation: true });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access when there is no user on the request', () => {
      const context = createContext(undefined);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('checks the block impersonation metadata against handler and class', () => {
      const context = createContext({ id: 'user-1' });

      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        BLOCK_IMPERSONATION_KEY,
        [context.getHandler(), context.getClass()],
      );
    });
  });

  describe('when handler is blocked', () => {
    beforeEach(() => {
      reflector.getAllAndOverride.mockReturnValue(true);
    });

    it('allows access when request.user is missing', () => {
      const context = createContext(undefined);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access when request.user.isImpersonation is falsy', () => {
      const context = createContext({ id: 'user-1', isImpersonation: false });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access when request.user.isImpersonation is undefined', () => {
      const context = createContext({ id: 'user-1' });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('throws ForbiddenException when request.user.isImpersonation is true', () => {
      const context = createContext({ id: 'user-1', isImpersonation: true });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('does not throw for impersonating user when metadata is false', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createContext({ id: 'user-1', isImpersonation: true });

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});