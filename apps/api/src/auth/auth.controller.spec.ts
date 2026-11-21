import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController, LoginThrottlerGuard, readCookie, REFRESH_COOKIE } from './auth.controller';
import type { AuthService } from './auth.service';

const tokens = { accessToken: 'access', refreshToken: 'refresh' };

function setup() {
  const service = {
    login: jest.fn().mockResolvedValue(tokens),
    refresh: jest.fn().mockResolvedValue(tokens),
    logout: jest.fn().mockResolvedValue(undefined),
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

describe('LoginThrottlerGuard', () => {
  const tracker = (req: object) =>
    (LoginThrottlerGuard.prototype as unknown as { getTracker(r: object): Promise<string> }).getTracker(req);

  it('tracks by normalized email, falling back to IP', async () => {
    await expect(tracker({ body: { email: ' A@B.co ' }, ip: '1.1.1.1' })).resolves.toBe('a@b.co');
    await expect(tracker({ body: {}, ip: '1.1.1.1' })).resolves.toBe('1.1.1.1');
  });
});
