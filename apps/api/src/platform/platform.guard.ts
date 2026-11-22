import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { readCookie } from '../auth/auth.controller';
import { PrismaService } from '../prisma/prisma.service';

/** Platform session cookie: own name and path, so it never travels with tenant requests (and vice versa). */
export const PLATFORM_COOKIE = 'pm_platform';
/** Audience of platform JWTs; TenantMiddleware refuses any token with an audience. */
export const PLATFORM_AUDIENCE = 'platform';

export interface PlatformAdmin {
  id: string;
  email: string;
  full_name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    platformAdmin?: PlatformAdmin;
  }
}

/** Platform routes (Q27): signed cookie of a platform admin that still exists. Runs on the system path. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = readCookie(req, PLATFORM_COOKIE);
    if (!token) throw new UnauthorizedException();
    let sub: string;
    try {
      ({ sub } = await this.jwt.verifyAsync<{ sub: string }>(token, { audience: PLATFORM_AUDIENCE }));
    } catch {
      throw new UnauthorizedException();
    }
    const admin = await this.prisma.platform_admins.findUnique({ where: { id: sub }, select: { id: true, email: true, full_name: true } });
    if (!admin) throw new UnauthorizedException();
    req.platformAdmin = admin;
    return true;
  }
}
