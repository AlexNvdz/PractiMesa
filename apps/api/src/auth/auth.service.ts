import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Parallel refreshes (two tabs) may present the same token right after rotation: not treated as theft. */
const REUSE_GRACE_MS = 30 * 1000;

/** Shown when the platform suspended the business (Q27). */
export const SUSPENDED = 'Este negocio está suspendido. Escríbenos para reactivarlo.';

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

  async login(email: string, password: string): Promise<Tokens> {
    const user = await this.prisma.users.findUnique({ where: { email: email.trim().toLowerCase() } });
    const valid = await verifyPassword(password, user?.password_hash ?? (await this.dummyHash));
    if (!user || !valid) throw new UnauthorizedException('Correo o contraseña incorrectos');
    return this.issue(user.id);
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
    if (row.expires_at.getTime() <= Date.now()) throw new UnauthorizedException();

    // Conditional update: only one of two concurrent refreshes wins the rotation.
    const { count } = await this.prisma.refresh_tokens.updateMany({
      where: { id: row.id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    if (count === 0) throw new UnauthorizedException();
    return this.issue(row.user_id);
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

  // Login, demo login and refresh all pass here, so a suspended business gets no new session.
  private async issue(userId: string): Promise<Tokens> {
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { organizations: { select: { suspended_at: true } } } });
    if (user?.organizations.suspended_at) throw new ForbiddenException(SUSPENDED);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refresh_tokens.create({
      data: { user_id: userId, token_hash: sha256(refreshToken), expires_at: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    const accessToken = await this.jwt.signAsync({ sub: userId }, { expiresIn: ACCESS_TTL_SECONDS });
    return { accessToken, refreshToken };
  }
}
