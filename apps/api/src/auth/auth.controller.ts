import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { email, nullable, oneOf, parseBody, text } from '../common/validation';
import { ACCESS_TTL_SECONDS, AuthService, DEMO_HANDLES, REFRESH_TTL_MS, Registration, Tokens } from './auth.service';

export const REFRESH_COOKIE = 'pm_refresh';
/** Linked device token (Q29). Path /api so /api/devices can tell which device is this browser. */
export const DEVICE_COOKIE = 'pm_device';
const DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function deviceCookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api', maxAge: DEVICE_TTL_MS };
}

/** Login is throttled per email: behind the web proxy every visitor shares one IP. */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email || req.ip;
  }
}

const DEMO_LOGIN = { handle: oneOf(...DEMO_HANDLES), role: oneOf('OWNER', 'ADMIN', 'CASHIER', 'WAITER', 'KITCHEN') };

/** Demo login exists only where DEMO_LOGIN=on (staging); elsewhere the routes answer 404. */
function requireDemo() {
  if (process.env.DEMO_LOGIN !== 'on') throw new NotFoundException();
}

/** PIN login is throttled per device (the lockout per user is the main defense, Q32). */
@Injectable()
export class PinThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return readCookie(req as Request, DEVICE_COOKIE) ?? req.ip;
  }
}

/** Link codes are throttled per business: guessing one needs ~10^11 tries, this allows 10 a minute. */
@Injectable()
export class LinkThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const handle = typeof req.body?.handle === 'string' ? req.body.handle.toLowerCase() : '';
    return `link:${handle}`;
  }
}

const HANDLE = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_]{3,30}$/.test(v);
const LINK = { handle: HANDLE, code: text(20) };

const PIN_LOGIN = {
  username: (v: unknown) => typeof v === 'string' && /^[a-z0-9.]{3,30}$/.test(v),
  pin: (v: unknown) => typeof v === 'string' && /^\d{4,6}$/.test(v),
};

// shortcut: one budget shared by every visitor (behind the web proxy they share one IP); per-client limits come with Cloudflare (Phase 5).
@Injectable()
export class DemoThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(): Promise<string> {
    return 'demo';
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

export function parseLogin(body: unknown): { email: string; password: string; handle?: string } {
  const { email, password, handle } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 150 || password.length > 200) {
    throw new BadRequestException('Correo y contraseña son obligatorios');
  }
  if (!email.trim() || !password) throw new BadRequestException('Correo y contraseña son obligatorios');
  if (handle !== undefined && (typeof handle !== 'string' || !/^[A-Za-z0-9_]{3,30}$/.test(handle))) {
    throw new BadRequestException('Identificador inválido');
  }
  return { email, password, handle };
}

const REGISTRATION = {
  handle: HANDLE,
  business_name: text(150),
  nit: nullable(text(30)),
  owner_name: text(120),
  email,
  phone: text(30),
  location_name: text(120),
  city: text(80),
  address: text(300),
};

/** Sign-up body; the password is read apart because parseBody trims strings and login does not. */
function parseRegistration(body: unknown): Registration {
  const data = parseBody<Omit<Registration, 'password'>>(body, REGISTRATION, [
    'handle',
    'business_name',
    'owner_name',
    'email',
    'phone',
    'location_name',
    'city',
    'address',
  ]);
  const { password } = body as { password?: unknown };
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');
  }
  return { ...data, password };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottlerGuard)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password, handle } = parseLogin(body);
    return this.respond(res, await this.auth.login(email, password, handle));
  }

  /** Login step 1: business behind the handle and this browser's device for it (Q32). */
  @Get('business/:handle')
  business(@Param('handle') handle: string, @Req() req: Request) {
    if (!/^[A-Za-z0-9_]{3,30}$/.test(handle)) throw new NotFoundException('No encontramos ese negocio. Revisa el identificador.');
    return this.auth.business(handle, readCookie(req, DEVICE_COOKIE));
  }

  /** Links this browser with the owner's one-time code; sets the device cookie. */
  @Post('device')
  @HttpCode(200)
  @UseGuards(LinkThrottlerGuard)
  async link(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { handle, code } = parseBody<{ handle: string; code: string }>(body, LINK, ['handle', 'code']);
    const { token, device } = await this.auth.linkDevice(handle, code, readCookie(req, DEVICE_COOKIE));
    res.cookie(DEVICE_COOKIE, token, deviceCookieOptions());
    return device;
  }

  /** Username + PIN on a linked device; the role comes from the user. */
  @Post('pin')
  @HttpCode(200)
  @UseGuards(PinThrottlerGuard)
  async pin(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { username, pin } = parseBody<{ username: string; pin: string }>(body, PIN_LOGIN, ['username', 'pin']);
    return this.respond(res, await this.auth.pinLogin(readCookie(req, DEVICE_COOKIE), username, pin));
  }

  /** Demo organizations on this environment, for the "Entrar como demo" buttons. */
  @Get('demo')
  demoOrganizations() {
    requireDemo();
    return this.auth.demoOrganizations(DEMO_HANDLES);
  }

  /** Session as the demo user of a role, without a password. */
  @Post('demo')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseGuards(DemoThrottlerGuard)
  async demoLogin(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    requireDemo();
    const { handle, role } = parseBody<{ handle: string; role: string }>(body, DEMO_LOGIN, ['handle', 'role']);
    return this.respond(res, await this.auth.demoLogin(handle, role));
  }

  /** Sign-up page (Q28): plan of the invitation, 404 when it is not usable. */
  @Get('register/:token')
  invitation(@Param('token') token: string) {
    return this.auth.invitation(token);
  }

  @Post('register/:token')
  @HttpCode(200)
  @UseGuards(LoginThrottlerGuard)
  async register(@Param('token') token: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.register(token, parseRegistration(body)));
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
