import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { hashPassword } from '../auth/password';
import { Roles } from '../common/guards/roles.guard';
import type { TenantContext } from '../common/tenant/tenant-context';
import { bool, oneOf, parseBody, text, uuid } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

/** Roles the owner creates; all of them sign in with username + PIN only. */
const STAFF = ['ADMIN', 'CASHIER', 'WAITER', 'KITCHEN'];

const USER = {
  id: true,
  given_names: true,
  family_names: true,
  full_name: true,
  username: true,
  email: true,
  role: true,
  allowed_location_ids: true,
  is_active: true,
  created_at: true,
  pin_hash: true,
} as const;

interface UserInput {
  given_names?: string;
  family_names?: string;
  username?: string;
  role?: string;
  location_ids?: string[];
  pin?: string;
  is_active?: boolean;
}

const RULES = {
  given_names: text(80),
  family_names: text(80),
  username: (v: unknown) => typeof v === 'string' && /^[a-z0-9.]{3,30}$/.test(v),
  role: oneOf(...STAFF),
  location_ids: (v: unknown) => Array.isArray(v) && v.length <= 20 && v.every(uuid),
  pin: (v: unknown) => typeof v === 'string' && /^\d{4,6}$/.test(v),
  is_active: bool,
};

type Row = { pin_hash: string | null } & Record<string, unknown>;
/** Never the hashes: only whether a PIN is set. */
const view = ({ pin_hash, ...user }: Row) => ({ ...user, has_pin: pin_hash !== null });

/**
 * Team: only the owner creates and edits people (supervisors included). The owner is not on the list:
 * its own data changes only in "Mi cuenta" (/api/me).
 */
@Controller('users')
@Roles('OWNER')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    const users = await this.prisma
      .forTenant(req.tenant!.organizationId)
      .users.findMany({ where: { role: { not: 'OWNER' } }, select: USER, orderBy: [{ is_active: 'desc' }, { full_name: 'asc' }] });
    return users.map(view);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<UserInput>(body, RULES, ['given_names', 'family_names', 'username', 'role', 'pin']);
    const locations = this.locationsFor(tenant, data.location_ids ?? []);
    await this.assertFree(tenant, data.username!);

    const user = await this.prisma.forTenant(tenant.organizationId).users.create({
      data: {
        given_names: data.given_names,
        family_names: data.family_names,
        full_name: `${data.given_names} ${data.family_names}`,
        username: data.username,
        role: data.role!,
        allowed_location_ids: locations,
        pin_hash: await hashPassword(data.pin!),
      },
      select: USER,
    });
    return view(user);
  }

  @Patch(':id')
  async update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<UserInput>(body, { ...RULES, pin: undefined });
    const target = await this.staff(tenant, id);
    if (data.username !== undefined) await this.assertFree(tenant, data.username, id);
    const given = data.given_names ?? target.given_names;
    const family = data.family_names ?? target.family_names;

    const user = await this.prisma.forTenant(tenant.organizationId).users.update({
      where: { id },
      data: {
        given_names: data.given_names,
        family_names: data.family_names,
        // Names typed apart become the display name; an owner without them keeps the sign-up name.
        full_name: given && family ? `${given} ${family}` : undefined,
        username: data.username,
        role: data.role,
        allowed_location_ids: data.location_ids && this.locationsFor(tenant, data.location_ids),
        is_active: data.is_active,
      },
      select: USER,
    });
    return view(user);
  }

  @Put(':id/pin')
  @HttpCode(204)
  async setPin(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { pin } = parseBody<{ pin: string }>(body, { pin: RULES.pin }, ['pin']);
    await this.staff(req.tenant!, id);
    await this.prisma.forTenant(req.tenant!.organizationId).users.update({ where: { id }, data: { pin_hash: await hashPassword(pin) } });
  }

  /** A team member; RLS already hides other businesses (404) and the owner is edited only in Mi cuenta. */
  private async staff(tenant: TenantContext, id: string) {
    const target = await this.prisma.forTenant(tenant.organizationId).users.findUniqueOrThrow({ where: { id } });
    if (target.role === 'OWNER') throw new ForbiddenException('Tus datos se cambian en Mi cuenta');
    return target;
  }

  /**
   * Locations to store: [] = all. On SINGLE there is one location, so always [].
   * Ids must be active locations.
   */
  private locationsFor(tenant: TenantContext, ids: string[]) {
    if (tenant.planTier === 'SINGLE') return [];
    const unique = [...new Set(ids)];
    if (!unique.every((l) => tenant.locationIds.includes(l))) throw new BadRequestException('Sede inválida');
    return unique;
  }

  /** Friendly 409; the unique index still catches a race (generic 409). */
  private async assertFree(tenant: TenantContext, username: string, except?: string) {
    const taken = await this.prisma.forTenant(tenant.organizationId).users.findFirst({ where: { username, id: { not: except } } });
    if (taken) throw new ConflictException('Ese usuario ya existe en tu negocio. Prueba con otro.');
  }
}
