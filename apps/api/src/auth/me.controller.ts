import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Patch, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { email, parseBody, text } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import '../common/tenant/tenant-context';

const PIN = (v: unknown) => typeof v === 'string' && /^\d{4,6}$/.test(v);
const USERNAME = (v: unknown) => typeof v === 'string' && /^[a-z0-9.]{3,30}$/.test(v);

/** Password fields read raw: parseBody trims strings and login does not. */
function rawPassword(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 200) throw new BadRequestException('Contraseña inválida');
  return value;
}

/** Current session and "Mi cuenta": who is logged in, in which organization, with which locations. */
@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async me(@Req() req: Request) {
    const tenant = req.tenant!; // TenantMiddleware runs on this route
    const db = this.prisma.forTenant(tenant.organizationId);
    const [{ pin_hash, ...user }, organization, locations, device] = await Promise.all([
      db.users.findUniqueOrThrow({
        where: { id: tenant.userId },
        select: { id: true, full_name: true, given_names: true, family_names: true, email: true, role: true, username: true, pin_hash: true },
      }),
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
    return { user: { ...user, has_pin: pin_hash !== null }, organization, locations, current_location_id: tenant.locationId ?? null, device };
  }

  /** Anyone changes its own PIN; the current one is asked (and counts toward the lockout) when there is one. */
  @Put('pin')
  @HttpCode(204)
  async setPin(@Req() req: Request, @Body() body: unknown) {
    const { userId } = req.tenant!;
    const { pin, current_pin } = parseBody<{ pin: string; current_pin?: string }>(body, { pin: PIN, current_pin: PIN }, ['pin']);
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });
    // 400, not 401: the web client treats 401 as an expired session.
    if (user.pin_hash && !(current_pin && (await this.auth.checkPin(user, current_pin)))) {
      throw new BadRequestException('El PIN actual no es correcto');
    }
    await this.prisma.users.update({ where: { id: userId }, data: { pin_hash: await hashPassword(pin) } });
  }

  /** The owner changes its own names, and with the current password its username, email or password. */
  @Patch()
  @Roles('OWNER')
  async update(@Req() req: Request, @Body() body: unknown) {
    const { userId, organizationId } = req.tenant!;
    const data = parseBody<{ given_names?: string; family_names?: string; username?: string; email?: string }>(body, {
      given_names: text(80),
      family_names: text(80),
      username: USERNAME,
      email,
    });
    const current = rawPassword(body, 'current_password');
    const password = rawPassword(body, 'password');
    if (password !== undefined && password.length < 8) throw new BadRequestException('La contraseña nueva debe tener al menos 8 caracteres');
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });
    const access = data.username !== undefined || data.email !== undefined || password !== undefined;
    if (access && !(current && user.password_hash && (await verifyPassword(current, user.password_hash)))) {
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    const mail = data.email?.toLowerCase();
    if (data.username && (await this.prisma.users.findFirst({ where: { organization_id: organizationId, username: data.username, id: { not: userId } } }))) {
      throw new ConflictException('Ese usuario ya existe en tu negocio. Prueba con otro.');
    }
    if (mail && (await this.prisma.users.findFirst({ where: { email: mail, id: { not: userId } } }))) {
      throw new ConflictException('Ese correo ya tiene una cuenta en PractiMesa.');
    }
    const given = data.given_names ?? user.given_names;
    const family = data.family_names ?? user.family_names;
    const saved = await this.prisma.users.update({
      where: { id: userId },
      data: {
        given_names: data.given_names,
        family_names: data.family_names,
        full_name: given && family ? `${given} ${family}` : undefined,
        username: data.username,
        email: mail,
        password_hash: password && (await hashPassword(password)),
      },
      select: { full_name: true, username: true, email: true },
    });
    return saved;
  }
}
