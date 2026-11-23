import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Parallel refreshes (two tabs) may present the same token right after rotation: not treated as theft. */
const REUSE_GRACE_MS = 30 * 1000;

/** Shown when the platform suspended the business (Q27). */
export const SUSPENDED = 'Este negocio está suspendido. Escríbenos para reactivarlo.';
/** Shown when the owner or an admin deactivated the user. */
export const DEACTIVATED = 'Tu usuario está desactivado. Habla con el encargado del negocio.';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Demo organizations (Q13), fixed in code so demo login can never open a real business. */
export const DEMO_HANDLES = ['cafe_ejemplo', 'cadena_ejemplo'];
/** Handles nobody can sign up with: demo businesses and subdomains the app itself uses (Q4). */
const RESERVED_HANDLES = new Set([...DEMO_HANDLES, 'app', 'www', 'api', 'admin', 'plataforma', 'demo']);
export const INVITATION_GONE = 'Esta invitación no existe, ya se usó o venció. Pídele una nueva a PractiMesa.';

/** Sign-up form (Q28): the business, its owner and its first location. */
export interface Registration {
  handle: string;
  business_name: string;
  nit?: string | null;
  owner_name: string;
  email: string;
  phone: string;
  password: string;
  location_name: string;
  city: string;
  address: string;
}

const usable = () => ({ used_at: null, revoked_at: null, expires_at: { gt: new Date() } });

/** Only the owner signs in with email + password; everyone else, supervisors included, uses username + PIN. */
export const PIN_ONLY = 'Entra con tu usuario y PIN en un dispositivo vinculado del negocio.';
export const PIN_WRONG = 'Usuario o PIN incorrecto';
export const DEVICE_NOT_LINKED = 'Este dispositivo no está vinculado. Pide al dueño un código de vinculación.';
export const CODE_WRONG = 'Código incorrecto o vencido. Pide al dueño uno nuevo.';
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

// Link codes: 8 characters without look-alikes (0/O, 1/I/L), typed on the new device; 31^8 ≈ 8.5e11 combinations.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 10 * 60 * 1000;
export const newLinkCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
/** "abcd-efgh" and "ABCDEFGH" are the same code. */
export const linkCodeHash = (code: string) => sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Runs on the system path: no tenant exists before login. */
@Injectable()
export class AuthService {
  // Verifying against a throwaway hash keeps response time equal for unknown emails.
  private readonly dummyHash = hashPassword(randomUUID());

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Owner login. A typed business handle must be the user's own business. */
  async login(email: string, password: string, handle?: string): Promise<Tokens> {
    const user = await this.prisma.users.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { organizations: { select: { handle: true } } },
    });
    const valid = await verifyPassword(password, user?.password_hash ?? (await this.dummyHash));
    const otherBusiness = handle !== undefined && user?.organizations.handle.toLowerCase() !== handle.toLowerCase();
    if (!user || !valid || otherBusiness) throw new UnauthorizedException('Correo o contraseña incorrectos');
    if (user.role !== 'OWNER') throw new ForbiddenException(PIN_ONLY);
    return this.issue(user.id);
  }

  /** Login step 1: the business behind a handle and this browser's linked device for it, if any. Handles are public (store address). */
  async business(handle: string, deviceToken: string | undefined) {
    const org = await this.findBusiness(handle);
    const device = await this.device(deviceToken, org.id);
    return { handle: org.handle, name: org.name, device: device && { id: device.id, name: device.name, location: device.locations } };
  }

  private async findBusiness(handle: string) {
    const [org] = await this.prisma.$queryRaw<{ id: string; handle: string; name: string }[]>`
      SELECT id, handle, name FROM organizations WHERE lower(handle) = lower(${handle})`;
    if (!org) throw new NotFoundException('No encontramos ese negocio. Revisa el identificador.');
    return org;
  }

  /**
   * Links this browser with a one-time code the owner generated (spent here, of two uses only one wins).
   * Returns the device cookie token; a device this browser had before is deleted.
   */
  async linkDevice(handle: string, code: string, previousToken: string | undefined) {
    const org = await this.findBusiness(handle);
    const token = randomBytes(32).toString('base64url');
    const device = await this.prisma.$transaction(async (tx) => {
      const link = await tx.device_codes.findFirst({
        where: { code_hash: linkCodeHash(code), organization_id: org.id, expires_at: { gt: new Date() }, locations: { is_active: true } },
      });
      if (!link || !(await tx.device_codes.deleteMany({ where: { id: link.id } })).count) throw new UnauthorizedException(CODE_WRONG);
      if (previousToken) await tx.devices.deleteMany({ where: { token_hash: sha256(previousToken) } });
      return tx.devices.create({
        data: { organization_id: org.id, location_id: link.location_id, name: link.name, token_hash: sha256(token), created_by: link.created_by },
        include: { locations: { select: { id: true, name: true } } },
      });
    });
    return { token, device: { id: device.id, name: device.name, location: device.locations } };
  }

  /** Username + PIN, only on a linked device; role and location come from the user and the device. */
  async pinLogin(deviceToken: string | undefined, username: string, pin: string): Promise<Tokens> {
    const device = await this.device(deviceToken);
    if (!device) throw new UnauthorizedException(DEVICE_NOT_LINKED);
    const user = await this.prisma.users.findFirst({ where: { organization_id: device.organization_id, username } });
    const here = !!user && (user.allowed_location_ids.length === 0 || user.allowed_location_ids.includes(device.location_id));
    // One message for unknown user, other location or wrong PIN: nothing to learn from the error.
    if (!(await this.checkPin(user, pin, here)) || !user) throw new UnauthorizedException(PIN_WRONG);
    await this.prisma.devices.update({ where: { id: device.id }, data: { last_used_at: new Date() } });
    return this.issue(user.id, device.id);
  }

  /** Device of a browser token at an active location (optionally of one business). */
  private device(token: string | undefined, organizationId?: string) {
    if (!token) return Promise.resolve(null);
    return this.prisma.devices.findFirst({
      where: { token_hash: sha256(token), organization_id: organizationId, locations: { is_active: true } },
      include: { locations: { select: { id: true, name: true } } },
    });
  }

  /**
   * PIN check with the lockout: the 5th failure in a row locks the user for 5 minutes (429).
   * `ok` = other conditions of the attempt; a failed one counts like a wrong PIN.
   */
  async checkPin(user: { id: string; pin_hash: string | null; pin_locked_until: Date | null } | null, pin: string, ok = true) {
    if (user?.pin_locked_until && user.pin_locked_until > new Date()) {
      throw new HttpException('Demasiados intentos con ese usuario. Espera 5 minutos e inténtalo de nuevo.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const valid = (await verifyPassword(pin, user?.pin_hash ?? (await this.dummyHash))) && !!user?.pin_hash && ok;
    if (!user) return false;
    if (!valid) {
      await this.failPin(user.id);
      return false;
    }
    await this.prisma.users.update({ where: { id: user.id }, data: { pin_failed_count: 0, pin_locked_until: null } });
    return true;
  }

  private async failPin(userId: string) {
    const { pin_failed_count } = await this.prisma.users.update({
      where: { id: userId },
      data: { pin_failed_count: { increment: 1 } },
      select: { pin_failed_count: true },
    });
    if (pin_failed_count >= PIN_MAX_FAILS) {
      await this.prisma.users.update({ where: { id: userId }, data: { pin_failed_count: 0, pin_locked_until: new Date(Date.now() + PIN_LOCK_MS) } });
    }
  }

  demoOrganizations(handles: string[]) {
    return this.prisma.organizations.findMany({
      where: { handle: { in: handles } },
      select: { handle: true, name: true, plan_tier: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Session of the first user with the role in the organization; the controller only passes demo handles. */
  async demoLogin(handle: string, role: string): Promise<Tokens> {
    const user = await this.prisma.users.findFirst({
      where: { role, organizations: { handle } },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Ese usuario de demo no existe');
    return this.issue(user.id);
  }

  /** Rotates the refresh token. Reusing an already rotated token ends every session of that user. */
  async refresh(token: string | undefined): Promise<Tokens> {
    if (!token) throw new UnauthorizedException();
    const row = await this.prisma.refresh_tokens.findUnique({ where: { token_hash: sha256(token) } });
    if (!row) throw new UnauthorizedException();

    if (row.revoked_at) {
      if (Date.now() - row.revoked_at.getTime() > REUSE_GRACE_MS) {
        await this.prisma.refresh_tokens.updateMany({
          where: { user_id: row.user_id, revoked_at: null },
          data: { revoked_at: new Date() },
        });
      }
      throw new UnauthorizedException();
    }
    // A PIN session ends with its device: deleting the device deletes its refresh tokens (cascade).
    if (row.expires_at.getTime() <= Date.now()) throw new UnauthorizedException();

    // Conditional update: only one of two concurrent refreshes wins the rotation.
    const { count } = await this.prisma.refresh_tokens.updateMany({
      where: { id: row.id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    if (count === 0) throw new UnauthorizedException();
    return this.issue(row.user_id, row.device_id ?? undefined);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.refresh_tokens.updateMany({
      where: { token_hash: sha256(token), revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /** Plan of a usable invitation, for the sign-up page. */
  async invitation(token: string) {
    const invitation = await this.prisma.invitations.findFirst({
      where: { token_hash: sha256(token), ...usable() },
      select: { plan_tier: true, max_locations: true },
    });
    if (!invitation) throw new NotFoundException(INVITATION_GONE);
    return invitation;
  }

  /** Creates business + first location + OWNER in one transaction, spends the invitation and logs the owner in. */
  async register(token: string, data: Registration): Promise<Tokens> {
    const password_hash = await hashPassword(data.password);
    const email = data.email.toLowerCase();
    const userId = await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.invitations.findFirst({ where: { token_hash: sha256(token), ...usable() } });
      if (!invitation) throw new NotFoundException(INVITATION_GONE);
      const taken = await tx.$queryRaw<unknown[]>`SELECT 1 FROM organizations WHERE lower(handle) = lower(${data.handle})`;
      if (taken.length || RESERVED_HANDLES.has(data.handle.toLowerCase())) {
        throw new ConflictException('Ese identificador ya está en uso. Prueba con otro.');
      }
      if (await tx.users.findUnique({ where: { email }, select: { id: true } })) {
        throw new ConflictException('Ese correo ya tiene una cuenta en PractiMesa. Usa otro o inicia sesión.');
      }
      const org = await tx.organizations.create({
        data: {
          name: data.business_name,
          handle: data.handle,
          nit: data.nit ?? null,
          plan_tier: invitation.plan_tier,
          max_locations: invitation.max_locations,
        },
      });
      await tx.locations.create({ data: { organization_id: org.id, name: data.location_name, city: data.city, address: data.address } });
      const user = await tx.users.create({
        data: { organization_id: org.id, email, password_hash, full_name: data.owner_name, phone: data.phone, role: 'OWNER' },
      });
      // Conditional: of two sign-ups (or a sign-up and a revoke) with the same link, only one commits.
      const { count } = await tx.invitations.updateMany({
        where: { id: invitation.id, ...usable() },
        data: { used_at: new Date(), organization_id: org.id },
      });
      if (!count) throw new NotFoundException(INVITATION_GONE);
      return user.id;
    });
    return this.issue(userId);
  }

  /** Platform admin id (Q27); same error and timing as tenant login. */
  async platformLogin(email: string, password: string): Promise<string> {
    const admin = await this.prisma.platform_admins.findFirst({ where: { email: email.trim().toLowerCase() } });
    const valid = await verifyPassword(password, admin?.password_hash ?? (await this.dummyHash));
    if (!admin || !valid) throw new UnauthorizedException('Correo o contraseña incorrectos');
    return admin.id;
  }

  // Login, demo login, sign-up and refresh all pass here, so a suspended business or deactivated user gets no new session.
  private async issue(userId: string, deviceId?: string): Promise<Tokens> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { is_active: true, organizations: { select: { suspended_at: true } } },
    });
    if (user?.organizations.suspended_at) throw new ForbiddenException(SUSPENDED);
    if (user && !user.is_active) throw new ForbiddenException(DEACTIVATED);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refresh_tokens.create({
      data: { user_id: userId, device_id: deviceId, token_hash: sha256(refreshToken), expires_at: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    // `dev` ties a PIN session to its device: TenantMiddleware checks it and fixes the location.
    const accessToken = await this.jwt.signAsync(deviceId ? { sub: userId, dev: deviceId } : { sub: userId }, { expiresIn: ACCESS_TTL_SECONDS });
    return { accessToken, refreshToken };
  }
}
