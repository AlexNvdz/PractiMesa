import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import '../tenant/tenant-context';

/**
 * Blocks creating a location beyond the plan limit (SINGLE = 1 always).
 * Use on the "create location" route: @UseGuards(PlanGuard).
 * shortcut: count-then-insert can race under concurrent requests; re-check inside the create transaction in Phase 2.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const tenant = ctx.switchToHttp().getRequest<Request>().tenant;
    if (!tenant) throw new ForbiddenException();

    const limit = tenant.planTier === 'SINGLE' ? 1 : tenant.maxLocations;
    // Inactive locations count too, so deactivate + create cannot bypass the limit.
    const count = await this.prisma.locations.count({ where: { organization_id: tenant.organizationId } });
    if (count >= limit) {
      throw new ForbiddenException(
        tenant.planTier === 'SINGLE'
          ? 'El plan Pequeño permite 1 sede. Cambia a Multilocal para agregar más.'
          : `Tu plan permite ${limit} sedes.`,
      );
    }
    return true;
  }
}
