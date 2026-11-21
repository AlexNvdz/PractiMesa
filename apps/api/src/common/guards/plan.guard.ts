import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import '../tenant/tenant-context';

/** Throws when the organization already has as many locations as its plan allows (SINGLE = 1 always). */
export function assertLocationLimit(planTier: string, maxLocations: number, count: number) {
  const limit = planTier === 'SINGLE' ? 1 : maxLocations;
  if (count >= limit) {
    throw new ForbiddenException(
      planTier === 'SINGLE'
        ? 'El plan Pequeño permite 1 sede. Cambia a Multilocal para agregar más.'
        : `Tu plan permite ${limit} sedes.`,
    );
  }
}

/**
 * Blocks creating a location beyond the plan limit. Use on the "create location" route: @UseGuards(PlanGuard).
 * This is the fast path; the create transaction re-checks under a lock because count-then-insert can race.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const tenant = ctx.switchToHttp().getRequest<Request>().tenant;
    if (!tenant) throw new ForbiddenException();

    // Inactive locations count too, so deactivate + create cannot bypass the limit.
    const count = await this.prisma.locations.count({ where: { organization_id: tenant.organizationId } });
    assertLocationLimit(tenant.planTier, tenant.maxLocations, count);
    return true;
  }
}
