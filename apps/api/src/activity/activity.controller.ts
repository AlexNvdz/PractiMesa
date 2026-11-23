import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation, type TenantContext } from '../common/tenant/tenant-context';
import { type Check, oneOf, parseBody, uuid } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ActivityKind = 'STOCK_RECEIVE' | 'STOCK_COUNT' | 'REGISTER_OPEN' | 'REGISTER_CLOSE';
const KINDS: Record<string, ActivityKind[]> = {
  inventory: ['STOCK_RECEIVE', 'STOCK_COUNT'],
  cash: ['REGISTER_OPEN', 'REGISTER_CLOSE'],
};

/** Writes one entry inside the request's transaction: it exists only if the change it describes was saved. */
export function logActivity(
  tx: Prisma.TransactionClient,
  tenant: TenantContext,
  locationId: string,
  kind: ActivityKind,
  details: Record<string, string>,
  ingredientId?: string,
) {
  return tx.activity_log.create({ data: { location_id: locationId, user_id: tenant.userId, kind, ingredient_id: ingredientId, details } });
}

const date: Check = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const FILTERS = {
  type: oneOf('inventory', 'cash'),
  user: uuid,
  ingredient: uuid,
  from: date,
  to: date,
  /** Cursor: entries older than this (the created_at of the last one shown). */
  before: date,
  limit: (v: unknown) => typeof v === 'string' && /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 100,
};
interface Filters {
  type?: string;
  user?: string;
  ingredient?: string;
  from?: string;
  to?: string;
  before?: string;
  limit?: string;
}

/**
 * Activity log of the request location (Q41, Q57): stock received and counted, registers opened and closed.
 * The owner sees every location (switching it in the header); a supervisor only the ones assigned to them.
 */
@Controller('activity')
@Roles('OWNER', 'ADMIN')
export class ActivityController {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first, a page at a time. */
  @Get()
  list(@Req() req: Request) {
    const tenant = req.tenant!;
    const f = parseBody<Filters>(req.query, FILTERS);
    const at = (v?: string) => (v ? new Date(v) : undefined);
    return this.prisma.forTenant(tenant.organizationId).activity_log.findMany({
      where: {
        location_id: requireLocation(tenant),
        kind: f.type ? { in: KINDS[f.type] } : undefined,
        user_id: f.user,
        ingredient_id: f.ingredient,
        created_at: { gte: at(f.from), lte: at(f.to), lt: at(f.before) },
      },
      orderBy: { created_at: 'desc' },
      take: f.limit ? Number(f.limit) : 50,
      include: { users: { select: { full_name: true } } },
    });
  }

  /** People with entries at this location, for the user filter (supervisors cannot list the team). */
  @Get('users')
  users(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma.forTenant(tenant.organizationId).users.findMany({
      where: { activity_log: { some: { location_id: requireLocation(tenant) } } },
      select: { id: true, full_name: true },
      orderBy: { full_name: 'asc' },
    });
  }
}
