import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController, DEMO_HANDLES, DemoThrottlerGuard, LoginThrottlerGuard, readCookie, REFRESH_COOKIE } from './auth.controller';
import type { AuthService } from './auth.service';

const tokens = { accessToken: 'access', refreshToken: 'refresh' };

function setup() {
  const service = {
    login: jest.fn().mockResolvedValue(tokens),
    refresh: jest.fn().mockResolvedValue(tokens),
    logout: jest.fn().mockResolvedValue(undefined),
    demoOrganizations: jest.fn().mockResolvedValue([{ handle: 'cafe_ejemplo', name: 'Café Ejemplo', plan_tier: 'SINGLE' }]),
    demoLogin: jest.fn().mockResolvedValue(tokens),
  };
  const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
  return { controller: new AuthController(service as unknown as AuthService), service, res };
}

const reqWithCookie = (cookie?: string) => ({ headers: { cookie } }) as unknown as Request;

describe('AuthController', () => {
  it('login returns the access token and sets an httpOnly strict refresh cookie', async () => {
    const { controller, res } = setup();
    await expect(controller.login({ email: 'a@b.co', password: 'x' }, res)).resolves.toEqual({
      access_token: 'access',
      expires_in: 900,
    });
    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/auth' }),
    );
  });

  it.each([undefined, {}, { email: 'a@b.co' }, { email: ' ', password: 'x' }, { email: 1, password: 2 }])(
    'login rejects invalid body %p',
    async (body) => {
      const { controller, res } = setup();
      await expect(controller.login(body, res)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('refresh reads the cookie and rotates it', async () => {
    const { controller, service, res } = setup();
    await controller.refresh(reqWithCookie(`other=1; ${REFRESH_COOKIE}=tok`), res);
    expect(service.refresh).toHaveBeenCalledWith('tok');
    expect(res.cookie).toHaveBeenCalled();
  });

  it('refresh clears the cookie when the token is rejected', async () => {
    const { controller, service, res } = setup();
    service.refresh.mockRejectedValue(new UnauthorizedException());
    await expect(controller.refresh(reqWithCookie(), res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, expect.objectContaining({ path: '/api/auth' }));
  });

  it('logout revokes and clears the cookie', async () => {
    const { controller, service, res } = setup();
    await controller.logout(reqWithCookie(`${REFRESH_COOKIE}=tok`), res);
    expect(service.logout).toHaveBeenCalledWith('tok');
    expect(res.clearCookie).toHaveBeenCalled();
  });

  it('readCookie returns undefined without cookies', () => {
    expect(readCookie(reqWithCookie(), REFRESH_COOKIE)).toBeUndefined();
  });
});

describe('demo login', () => {
  // A developer's .env may turn it on: every test sets it explicitly.
  beforeEach(() => delete process.env.DEMO_LOGIN);

  it('does not exist unless DEMO_LOGIN=on', async () => {
    const { controller, service, res } = setup();
    expect(() => controller.demoOrganizations()).toThrow(NotFoundException);
    await expect(controller.demoLogin({ handle: 'cafe_ejemplo', role: 'OWNER' }, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.demoLogin).not.toHaveBeenCalled();
  });

  it('lists the demo organizations and opens a session like login', async () => {
    process.env.DEMO_LOGIN = 'on';
    const { controller, service, res } = setup();
    await expect(controller.demoOrganizations()).resolves.toHaveLength(1);
    expect(service.demoOrganizations).toHaveBeenCalledWith(DEMO_HANDLES);
    await expect(controller.demoLogin({ handle: 'cadena_ejemplo', role: 'KITCHEN' }, res)).resolves.toEqual({ access_token: 'access', expires_in: 900 });
    expect(service.demoLogin).toHaveBeenCalledWith('cadena_ejemplo', 'KITCHEN');
    expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'refresh', expect.objectContaining({ httpOnly: true }));
  });

  it.each([{ handle: 'un_cliente_real', role: 'OWNER' }, { handle: 'cafe_ejemplo', role: 'SUPERADMIN' }, { handle: 'cafe_ejemplo' }, undefined])(
    'rejects anything but a demo organization and role: %p',
    async (body) => {
      process.env.DEMO_LOGIN = 'on';
      const { controller, service, res } = setup();
      await expect(controller.demoLogin(body, res)).rejects.toBeInstanceOf(BadRequestException);
      expect(service.demoLogin).not.toHaveBeenCalled();
    },
  );

  it('shares one throttling budget between visitors', async () => {
    const tracker = (DemoThrottlerGuard.prototype as unknown as { getTracker(): Promise<string> }).getTracker();
    await expect(tracker).resolves.toBe('demo');
  });
});

describe('LoginThrottlerGuard', () => {
  const tracker = (req: object) =>
    (LoginThrottlerGuard.prototype as unknown as { getTracker(r: object): Promise<string> }).getTracker(req);

  it('tracks by normalized email, falling back to IP', async () => {
    await expect(tracker({ body: { email: ' A@B.co ' }, ip: '1.1.1.1' })).resolves.toBe('a@b.co');
    await expect(tracker({ body: {}, ip: '1.1.1.1' })).resolves.toBe('1.1.1.1');
  });
});
