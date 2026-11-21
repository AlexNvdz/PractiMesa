// Integration test: needs Postgres with migrations applied.
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';

const db = new PrismaService();
const jwt = new JwtService({ secret: 'test-secret' });
const auth = new AuthService(db, jwt);
const suffix = randomUUID().slice(0, 8);
const email = `owner-${suffix}@test.demo`;
let orgId: string;
let userId: string;

beforeAll(async () => {
  orgId = (await db.organizations.create({ data: { name: 'Auth test', slug: `auth-${suffix}`, plan_tier: 'SINGLE' } })).id;
  userId = (
    await db.users.create({
      data: { organization_id: orgId, email, password_hash: await hashPassword('s3cret-pass'), full_name: 'Owner', role: 'OWNER' },
    })
  ).id;
});

afterAll(async () => {
  await db.organizations.delete({ where: { id: orgId } });
  await db.$disconnect();
});

describe('AuthService', () => {
  it('lists the requested demo organizations and logs in as the first user of a role', async () => {
    await expect(auth.demoOrganizations([`auth-${suffix}`, 'no-existe'])).resolves.toEqual([
      { slug: `auth-${suffix}`, name: 'Auth test', plan_tier: 'SINGLE' },
    ]);
    const tokens = await auth.demoLogin(`auth-${suffix}`, 'OWNER');
    await expect(jwt.verifyAsync(tokens.accessToken)).resolves.toMatchObject({ sub: userId });
    await expect(auth.demoLogin(`auth-${suffix}`, 'KITCHEN')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('logs in with case-insensitive email and issues a JWT for the user', async () => {
    const tokens = await auth.login(`  ${email.toUpperCase()} `, 's3cret-pass');
    await expect(jwt.verifyAsync(tokens.accessToken)).resolves.toMatchObject({ sub: userId });
    expect(tokens.refreshToken.length).toBeGreaterThan(40);
  });

  it('stores only a hash of the refresh token', async () => {
    const { refreshToken } = await auth.login(email, 's3cret-pass');
    const rows = await db.refresh_tokens.findMany({ where: { user_id: userId } });
    expect(rows.some((r) => r.token_hash === refreshToken)).toBe(false);
  });

  it('rejects a wrong password and an unknown email with the same error', async () => {
    await expect(auth.login(email, 'nope')).rejects.toThrow('Correo o contraseña incorrectos');
    await expect(auth.login(`ghost-${suffix}@test.demo`, 'nope')).rejects.toThrow('Correo o contraseña incorrectos');
  });

  it('rotates the refresh token: the old one stops working', async () => {
    const first = await auth.login(email, 's3cret-pass');
    const second = await auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh(second.refreshToken)).resolves.toBeDefined();
  });

  it('revokes every session when a rotated token is reused after the grace window', async () => {
    const stolen = await auth.login(email, 's3cret-pass');
    const current = await auth.refresh(stolen.refreshToken);
    await db.refresh_tokens.updateMany({
      where: { revoked_at: { not: null }, user_id: userId },
      data: { revoked_at: new Date(Date.now() - 60_000) },
    });

    await expect(auth.refresh(stolen.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh(current.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets only one of two concurrent refreshes win', async () => {
    const { refreshToken } = await auth.login(email, 's3cret-pass');
    const results = await Promise.allSettled([auth.refresh(refreshToken), auth.refresh(refreshToken)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects expired, unknown and missing refresh tokens', async () => {
    const { refreshToken } = await auth.login(email, 's3cret-pass');
    await db.refresh_tokens.updateMany({ where: { user_id: userId, revoked_at: null }, data: { expires_at: new Date(0) } });
    await expect(auth.refresh(refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh('unknown')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.refresh(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logout revokes the refresh token', async () => {
    const { refreshToken } = await auth.login(email, 's3cret-pass');
    await auth.logout(refreshToken);
    await auth.logout(undefined);
    await expect(auth.refresh(refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
