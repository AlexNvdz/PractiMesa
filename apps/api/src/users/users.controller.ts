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
import { bool, email, oneOf, parseBody, text, uuid } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

/** Roles that sign in with username + PIN only (Q31). */
const WORKERS = ['CASHIER', 'WAITER', 'KITCHEN'];

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
  email?: string;
  is_active?: boolean;
}

const RULES = {
  given_names: text(80),
  family_names: text(80),
  username: (v: unknown) => typeof v === 'string' && /^[a-z0-9.]{3,30}$/.test(v),
  role: oneOf('ADMIN', ...WORKERS),
  location_ids: (v: unknown) => Array.isArray(v) && v.length <= 20 && v.every(uuid),
  pin: (v: unknown) => typeof v === 'string' && /^\d{4,6}$/.test(v),
  email,
  is_active: bool,
};

type Row = { pin_hash: string | null } & Record<string, unknown>;
/** Never the hashes: only whether a PIN is set. */
const view = ({ pin_hash, ...user }: Row) => ({ ...user, has_pin: pin_hash !== null });

/**
 * Q42: the owner manages everyone; anyone manages itself; an admin manages workers whose locations are all
 * among its own. An empty allowed list means every location of the business.
 */
function canManage(tenant: TenantContext, target: { id: string; role: string; allowed_location_ids: string[] }, orgLocations: string[]) {
  if (tenant.role === 'OWNER' || target.id === tenant.userId) return true;
  if (!WORKERS.includes(target.role)) return false;
  const theirs = target.allowed_location_ids.length ? target.allowed_location_ids : orgLocations;
  return theirs.every((l) => tenant.locationIds.includes(l));
}

/** Password of a new admin, read raw like login reads it (parseBody trims strings). */
function readPassword(body: unknown): string | undefined {
  const { password } = body as { password?: unknown };
  if (password === undefined) return undefined;
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');
  }
  return password;
}

/**
 * Team (Q30-Q31, Q42). The owner manages everyone; an admin only manages cashiers, waiters and kitchen
 * staff whose locations are all among the admin's own. Owners and admins may edit their own names,
 * username and PIN, never their own role, locations or state.
 */
@Controller('users')
@Roles('OWNER', 'ADMIN')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const db = this.prisma.forTenant(tenant.organizationId);
    const [users, orgLocations] = await Promise.all([
      db.users.findMany({ select: USER, orderBy: [{ is_active: 'desc' }, { full_name: 'asc' }] }),
      this.activeLocations(tenant),
    ]);
    // The screen shows which rows the caller may edit; the API still checks on every change.
    return users.map((u) => ({ ...view(u), can_manage: canManage(tenant, u, orgLocations) }));
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<UserInput>(body, RULES, ['given_names', 'family_names', 'username', 'role']);
    const password = readPassword(body);
    const isAdmin = data.role === 'ADMIN';
    if (isAdmin && tenant.role !== 'OWNER') throw new ForbiddenException('Solo el dueño crea administradores');
    if (isAdmin && (!data.email || !password)) throw new BadRequestException('Un administrador necesita correo y contraseña');
    if (!isAdmin && (data.email || password)) throw new BadRequestException('Cajeros, meseros y cocina entran con usuario y PIN, sin correo');
    if (!isAdmin && !data.pin) throw new BadRequestException('Asigna un PIN de 4 a 6 dígitos');
    const locations = await this.locationsFor(tenant, data.location_ids ?? []);
    await this.assertFree(tenant, data.username!, data.email);

    const user = await this.prisma.forTenant(tenant.organizationId).users.create({
      data: {
        given_names: data.given_names,
        family_names: data.family_names,
        full_name: `${data.given_names} ${data.family_names}`,
        username: data.username,
        role: data.role!,
        allowed_location_ids: locations,
        email: data.email?.toLowerCase() ?? null,
        password_hash: password ? await hashPassword(password) : null,
        pin_hash: data.pin ? await hashPassword(data.pin) : null,
      },
      select: USER,
    });
    return view(user);
  }

  @Patch(':id')
  async update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<UserInput>(body, { ...RULES, pin: undefined });
    const password = readPassword(body);
    const target = await this.manageable(tenant, id);
    const self = id === tenant.userId;
    if (self && (data.role !== undefined || data.location_ids !== undefined || data.is_active !== undefined)) {
      throw new ForbiddenException('No puedes cambiar tu propio rol, tus sedes ni desactivarte');
    }
    if ((data.role === 'ADMIN' || data.email !== undefined || password) && tenant.role !== 'OWNER') {
      throw new ForbiddenException('Solo el dueño maneja administradores y sus accesos');
    }
    const role = data.role ?? target.role;
    if (role === 'ADMIN' && (!(data.email ?? target.email) || !(password ?? target.password_hash))) {
      throw new BadRequestException('Un administrador necesita correo y contraseña');
    }
    if (data.username !== undefined || data.email !== undefined) {
      await this.assertFree(tenant, data.username, data.email, id);
    }
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
        allowed_location_ids: data.location_ids && (await this.locationsFor(tenant, data.location_ids)),
        is_active: data.is_active,
        email: data.email?.toLowerCase(),
        password_hash: password && (await hashPassword(password)),
      },
      select: USER,
    });
    return view(user);
  }

  @Put(':id/pin')
  @HttpCode(204)
  async setPin(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { pin } = parseBody<{ pin: string }>(body, { pin: RULES.pin }, ['pin']);
    await this.manageable(req.tenant!, id);
    await this.prisma.forTenant(req.tenant!.organizationId).users.update({ where: { id }, data: { pin_hash: await hashPassword(pin) } });
  }

  /** The target user if the caller may manage it (Q42); RLS already hides other businesses (404). */
  private async manageable(tenant: TenantContext, id: string) {
    const target = await this.prisma.forTenant(tenant.organizationId).users.findUniqueOrThrow({ where: { id } });
    if (!canManage(tenant, target, await this.activeLocations(tenant))) {
      throw new ForbiddenException(
        WORKERS.includes(target.role) ? 'Ese usuario trabaja en sedes que no manejas' : 'Solo el dueño maneja al dueño y a los administradores',
      );
    }
    return target;
  }

  private async activeLocations(tenant: TenantContext) {
    const rows = await this.prisma.forTenant(tenant.organizationId).locations.findMany({ where: { is_active: true }, select: { id: true } });
    return rows.map((l) => l.id);
  }

  /**
   * Locations to store: [] = all (owner only). On SINGLE there is one location, so always [].
   * Ids must be active locations the caller works in.
   */
  private async locationsFor(tenant: TenantContext, ids: string[]) {
    if (tenant.planTier === 'SINGLE') return [];
    const unique = [...new Set(ids)];
    if (!unique.length && tenant.role !== 'OWNER') throw new BadRequestException('Elige al menos una sede');
    if (!unique.every((l) => tenant.locationIds.includes(l))) throw new BadRequestException('Sede inválida');
    return unique;
  }

  /** Friendly 409s; the unique indexes still catch a race (generic 409). */
  private async assertFree(tenant: TenantContext, username?: string, mail?: string, except?: string) {
    if (username) {
      const taken = await this.prisma.forTenant(tenant.organizationId).users.findFirst({ where: { username, id: { not: except } } });
      if (taken) throw new ConflictException('Ese usuario ya existe en tu negocio. Prueba con otro.');
    }
    // Emails are unique across businesses: the system path sees them all.
    if (mail) {
      const taken = await this.prisma.users.findFirst({ where: { email: mail.toLowerCase(), id: { not: except } } });
      if (taken) throw new ConflictException('Ese correo ya tiene una cuenta en PractiMesa.');
    }
  }
}
