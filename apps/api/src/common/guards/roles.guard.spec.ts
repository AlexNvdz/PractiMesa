import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../tenant/tenant-context';
import { Roles, RolesGuard } from './roles.guard';

function ctx(required: Role[] | undefined, role?: Role): { guard: RolesGuard; context: ExecutionContext } {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ tenant: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
  return { guard: new RolesGuard(reflector), context };
}

describe('RolesGuard', () => {
  it('lets routes without @Roles through', () => {
    const { guard, context } = ctx(undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a listed role', () => {
    const { guard, context } = ctx(['OWNER', 'ADMIN'], 'ADMIN');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('forbids a role not listed', () => {
    const { guard, context } = ctx(['OWNER'], 'WAITER');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('reads roles declared with @Roles on a controller', () => {
    @Roles('OWNER')
    class OwnersOnly {}
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => function handler() {},
      getClass: () => OwnersOnly,
      switchToHttp: () => ({ getRequest: () => ({ tenant: { role: 'CASHIER' } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('forbids when there is no tenant', () => {
    const { guard, context } = ctx(['OWNER']);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
