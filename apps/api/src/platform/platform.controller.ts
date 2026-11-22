import { Body, ConflictException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions, Request, Response } from 'express';
import { LoginThrottlerGuard, parseLogin } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { bool, int, oneOf, parseBody } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_AUDIENCE, PLATFORM_COOKIE, PlatformGuard } from './platform.guard';

const SESSION_SECONDS = 8 * 60 * 60;

function cookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api/platform' };
}

/** What the platform sees of a business: identity, plan and state. Never orders, sales or customers (Q27). */
const ORGANIZATION = {
  id: true,
  handle: true,
  name: true,
  nit: true,
  plan_tier: true,
  max_locations: true,
  suspended_at: true,
  created_at: true,
  _count: { select: { locations: true } },
} as const;

const UPDATE = { plan_tier: oneOf('SINGLE', 'MULTI'), max_locations: int(1, 5), suspended: bool };

/** SaaS owner panel (Q27). System path: platform admins are outside every tenant. */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('auth/login')
  @HttpCode(204)
  @UseGuards(LoginThrottlerGuard)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parseLogin(body);
    const id = await this.auth.platformLogin(email, password);
    const token = await this.jwt.signAsync({ sub: id }, { audience: PLATFORM_AUDIENCE, expiresIn: SESSION_SECONDS });
    res.cookie(PLATFORM_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_SECONDS * 1000 });
  }

  // shortcut: the JWT stays valid until it expires (8 h) if the cookie was copied; add a session table if that matters.
  @Post('auth/logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(PLATFORM_COOKIE, cookieOptions());
  }

  @Get('me')
  @UseGuards(PlatformGuard)
  me(@Req() req: Request) {
    return req.platformAdmin;
  }

  @Get('organizations')
  @UseGuards(PlatformGuard)
  organizations() {
    return this.prisma.organizations.findMany({ select: ORGANIZATION, orderBy: { created_at: 'desc' } });
  }

  /** Plan, location limit (SINGLE = 1, MULTI up to 5) and suspension. */
  @Patch('organizations/:id')
  @UseGuards(PlatformGuard)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<{ plan_tier?: string; max_locations?: number; suspended?: boolean }>(body, UPDATE);
    return this.prisma.$transaction(async (tx) => {
      // Same row lock as location create, so a new location cannot slip past a lowered limit.
      const [org] = await tx.$queryRaw<{ plan_tier: string; max_locations: number; suspended_at: Date | null }[]>`
        SELECT plan_tier, max_locations, suspended_at FROM organizations WHERE id = ${id}::uuid FOR UPDATE`;
      if (!org) return tx.organizations.findUniqueOrThrow({ where: { id }, select: ORGANIZATION }); // 404
      const plan = data.plan_tier ?? org.plan_tier;
      // Moving to MULTI without a limit starts at 3 (Q25); SINGLE is always 1.
      let max = data.max_locations ?? (org.plan_tier === 'SINGLE' ? 3 : org.max_locations);
      if (plan === 'SINGLE') max = 1;
      // Inactive locations count too, as in PlanGuard.
      const count = await tx.locations.count({ where: { organization_id: id } });
      if (count > max) {
        throw new ConflictException(`El negocio tiene ${count} sedes: elimina las que sobran antes de bajar el tope a ${max}.`);
      }
      let suspended_at = org.suspended_at;
      if (data.suspended === false) suspended_at = null;
      else if (data.suspended) suspended_at ??= new Date();
      return tx.organizations.update({ where: { id }, data: { plan_tier: plan, max_locations: max, suspended_at }, select: ORGANIZATION });
    });
  }
}
