// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
const suffix = randomUUID().slice(0, 8);
const email = `platform-${suffix}@test.demo`;
let app: INestApplication;
let base: string;
let adminId: string;
let cookie: string;
let single: TestOrg;
let multi: TestOrg;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookie: res.headers.get('set-cookie') };
}

beforeAll(async () => {
  app = await startApp();
  base = await app.getUrl();
  adminId = (await db.platform_admins.create({ data: { email, password_hash: await hashPassword('platform-pass'), full_name: 'Plataforma' } })).id;
  single = await createOrg(db, 'SINGLE', 1);
  multi = await createOrg(db, 'MULTI', 2);
  const res = await call('POST', '/platform/auth/login', { email, password: 'platform-pass' }, {});
  cookie = res.setCookie!.split(';')[0];
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [single.id, multi.id] } } });
  await db.platform_admins.delete({ where: { id: adminId } });
  await db.$disconnect();
  await app.close();
});

describe('platform auth', () => {
  it('logs in with an httpOnly strict cookie scoped to /api/platform', async () => {
    const res = await call('POST', '/platform/auth/login', { email: email.toUpperCase(), password: 'platform-pass' }, {});
    expect(res.status).toBe(204);
    expect(res.setCookie).toMatch(/^pm_platform=.+; Max-Age=28800; Path=\/api\/platform; Expires=.+; HttpOnly; SameSite=Strict$/);
    await expect(call('GET', '/platform/me')).resolves.toMatchObject({ status: 200, body: { id: adminId, email, full_name: 'Plataforma' } });
  });

  it('rejects a wrong password, a missing cookie and a tenant token', async () => {
    expect((await call('POST', '/platform/auth/login', { email, password: 'nope' }, {})).status).toBe(401);
    expect((await call('GET', '/platform/organizations', undefined, {})).status).toBe(401);
    const tenant = await app.get(JwtService).signAsync({ sub: single.users.OWNER });
    expect((await call('GET', '/platform/organizations', undefined, { authorization: `Bearer ${tenant}` })).status).toBe(401);
    expect((await call('GET', '/platform/organizations', undefined, { cookie: `pm_platform=${tenant}` })).status).toBe(401);
  });

  it('platform tokens do not open the tenant API', async () => {
    const platform = cookie.slice('pm_platform='.length);
    expect((await call('GET', '/me', undefined, { authorization: `Bearer ${platform}` })).status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const res = await call('POST', '/platform/auth/logout');
    expect(res.status).toBe(204);
    expect(res.setCookie).toMatch(/^pm_platform=; Path=\/api\/platform;/);
  });
});

describe('platform organizations', () => {
  it('lists businesses with plan, state and location count, and nothing of their operation', async () => {
    const res = await call('GET', '/platform/organizations');
    expect(res.status).toBe(200);
    const org = res.body.find((o: { id: string }) => o.id === multi.id);
    expect(org).toMatchObject({ handle: expect.stringMatching(/^t_/), plan_tier: 'MULTI', max_locations: 3, suspended_at: null, _count: { locations: 2 } });
    expect(Object.keys(org).sort()).toEqual(['_count', 'created_at', 'handle', 'id', 'max_locations', 'name', 'nit', 'plan_tier', 'suspended_at']);
  });

  it('changes plan and limit: MULTI starts at 3, SINGLE is always 1, never below the locations it has', async () => {
    await expect(call('PATCH', `/platform/organizations/${single.id}`, { plan_tier: 'MULTI' })).resolves.toMatchObject({
      status: 200,
      body: { plan_tier: 'MULTI', max_locations: 3 },
    });
    await expect(call('PATCH', `/platform/organizations/${single.id}`, { max_locations: 5 })).resolves.toMatchObject({ body: { max_locations: 5 } });
    await expect(call('PATCH', `/platform/organizations/${single.id}`, { plan_tier: 'SINGLE', max_locations: 4 })).resolves.toMatchObject({
      body: { plan_tier: 'SINGLE', max_locations: 1 },
    });

    const lower = await call('PATCH', `/platform/organizations/${multi.id}`, { max_locations: 1 });
    expect(lower.status).toBe(409);
    expect(lower.body.message).toContain('tiene 2 sedes');
    expect((await call('PATCH', `/platform/organizations/${multi.id}`, { plan_tier: 'SINGLE' })).status).toBe(409);
    expect((await call('PATCH', `/platform/organizations/${multi.id}`, { max_locations: 2 })).status).toBe(200);
  });

  it('validates the body and the id', async () => {
    expect((await call('PATCH', `/platform/organizations/${multi.id}`, { max_locations: 6 })).status).toBe(400);
    expect((await call('PATCH', `/platform/organizations/${multi.id}`, { plan_tier: 'GOLD' })).status).toBe(400);
    expect((await call('PATCH', `/platform/organizations/${randomUUID()}`, { suspended: true })).status).toBe(404);
    expect((await call('PATCH', '/platform/organizations/nope', {})).status).toBe(400);
  });

  it('suspends a business: its users get 403 until it is reactivated', async () => {
    const owner = await client(app, multi.users.OWNER);
    const suspended = await call('PATCH', `/platform/organizations/${multi.id}`, { suspended: true });
    expect(suspended.body.suspended_at).toEqual(expect.any(String));
    // Suspending again keeps the original date.
    await expect(call('PATCH', `/platform/organizations/${multi.id}`, { suspended: true })).resolves.toMatchObject({
      body: { suspended_at: suspended.body.suspended_at },
    });
    const denied = await owner('GET', '/me');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('suspendido');

    await expect(call('PATCH', `/platform/organizations/${multi.id}`, { suspended: false })).resolves.toMatchObject({ body: { suspended_at: null } });
    expect((await owner('GET', '/me')).status).toBe(200);
  });
});

describe('organization columns under RLS', () => {
  it('request code can rename its business but not change plan, limit, handle or suspension', async () => {
    const tenant = db.forTenant(single.id);
    await expect(tenant.organizations.update({ where: { id: single.id }, data: { name: 'Renombrado' } })).resolves.toMatchObject({ name: 'Renombrado' });
    for (const data of [{ max_locations: 5, plan_tier: 'MULTI' }, { handle: 'otro_nombre' }, { suspended_at: null }]) {
      await expect(tenant.organizations.update({ where: { id: single.id }, data })).rejects.toThrow(/permission denied/);
    }
  });
});
