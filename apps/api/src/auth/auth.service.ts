import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
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

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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
