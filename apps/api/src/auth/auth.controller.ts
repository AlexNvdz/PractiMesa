import { BadRequestException, Body, Controller, HttpCode, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { ACCESS_TTL_SECONDS, AuthService, REFRESH_TTL_MS, Tokens } from './auth.service';

export const REFRESH_COOKIE = 'pm_refresh';

/** Login is throttled per email: behind the web proxy every visitor shares one IP. */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email || req.ip;
  }
}

function cookieOptions(): CookieOptions {
  // The web app proxies /api to this server, so the cookie is first-party and can be Strict.
  return { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api/auth' };
}

export function readCookie(req: Request, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parseLogin(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 150 || password.length > 200) {
    throw new BadRequestException('Correo y contraseña son obligatorios');
  }
  if (!email.trim() || !password) throw new BadRequestException('Correo y contraseña son obligatorios');
  return { email, password };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottlerGuard)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parseLogin(body);
    return this.respond(res, await this.auth.login(email, password));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(readCookie(req, REFRESH_COOKIE)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readCookie(req, REFRESH_COOKIE));
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
  }

  private respond(res: Response, tokens: Tokens) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...cookieOptions(), maxAge: REFRESH_TTL_MS });
    return { access_token: tokens.accessToken, expires_in: ACCESS_TTL_SECONDS };
  }
}
