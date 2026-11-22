import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import '../common/tenant/tenant-context';

/** Current session: who is logged in, in which organization, with which locations. */
@Controller('me')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@Req() req: Request) {
    const tenant = req.tenant!; // TenantMiddleware runs on this route
    const db = this.prisma.forTenant(tenant.organizationId);
    const [user, organization, locations, device] = await Promise.all([
      db.users.findUniqueOrThrow({ where: { id: tenant.userId }, select: { id: true, full_name: true, email: true, role: true } }),
      db.organizations.findUniqueOrThrow({
        where: { id: tenant.organizationId },
        select: { id: true, name: true, handle: true, plan_tier: true, max_locations: true },
      }),
      db.locations.findMany({
        where: { id: { in: tenant.locationIds } },
        select: { id: true, name: true, city: true },
        orderBy: { name: 'asc' },
      }),
      // PIN session (Q33): the screen locks after 2 minutes idle.
      tenant.deviceId ? db.devices.findUnique({ where: { id: tenant.deviceId }, select: { id: true, name: true } }) : null,
    ]);
    return { user, organization, locations, current_location_id: tenant.locationId ?? null, device };
  }
}
