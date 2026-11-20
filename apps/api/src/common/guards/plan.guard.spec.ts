import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TenantContext } from '../tenant/tenant-context';
import { PlanGuard } from './plan.guard';

function setup(existingLocations: number) {
  const count = jest.fn().mockResolvedValue(existingLocations);
  const prisma = { locations: { count } } as unknown as PrismaService;
  return { guard: new PlanGuard(prisma), count };
}

function ctx(tenant?: Partial<TenantContext>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ tenant }) }),
  } as unknown as ExecutionContext;
}

const single = { organizationId: 'org-a', planTier: 'SINGLE', maxLocations: 1 } as const;
const multi = { organizationId: 'org-b', planTier: 'MULTI', maxLocations: 3 } as const;

describe('PlanGuard', () => {
  it('allows the first location on SINGLE', async () => {
    await expect(setup(0).guard.canActivate(ctx(single))).resolves.toBe(true);
  });

  it('blocks the 2nd location on SINGLE', async () => {
    await expect(setup(1).guard.canActivate(ctx(single))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks the 2nd location on SINGLE even if max_locations was raised by mistake', async () => {
    await expect(setup(1).guard.canActivate(ctx({ ...single, maxLocations: 5 }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a 2nd location on MULTI', async () => {
    await expect(setup(1).guard.canActivate(ctx(multi))).resolves.toBe(true);
  });

  it('blocks MULTI at max_locations', async () => {
    await expect(setup(3).guard.canActivate(ctx(multi))).rejects.toThrow('Tu plan permite 3 sedes.');
  });

  it('counts only the caller organization', async () => {
    const { guard, count } = setup(0);
    await guard.canActivate(ctx(multi));
    expect(count).toHaveBeenCalledWith({ where: { organization_id: 'org-b' } });
  });

  it('forbids when no tenant context exists', async () => {
    await expect(setup(0).guard.canActivate(ctx())).rejects.toBeInstanceOf(ForbiddenException);
  });
});
