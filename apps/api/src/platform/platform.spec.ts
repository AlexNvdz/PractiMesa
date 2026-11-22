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
  // Businesses created by the sign-up tests.
  await db.organizations.deleteMany({ where: { handle: { startsWith: `Reg_${suffix}` } } });
  await db.invitations.deleteMany({ where: { created_by: adminId } });
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

describe('invitations and sign-up', () => {
  let n = 0;
  const registration = (overrides: Record<string, unknown> = {}) => {
    n += 1;
    return {
      handle: `Reg_${suffix}_${n}`,
      business_name: 'Pizzería Darío',
      nit: null,
      owner_name: 'Darío Gómez',
      email: `reg-${suffix}-${n}@test.demo`,
      phone: '+57 300 000 0000',
      password: ' una clave larga ',
      location_name: 'Sede Centro',
      city: 'Medellín',
      address: 'Calle 10 #40-20',
      ...overrides,
    };
  };
  const invite = async (body: object = { plan_tier: 'MULTI', note: 'Cliente de prueba' }) => {
    const res = await call('POST', '/platform/invitations', body);
    expect(res.status).toBe(201);
    return res.body as { id: string; token: string; plan_tier: string; max_locations: number };
  };
  const register = (token: string, body: object = registration()) => call('POST', `/auth/register/${token}`, body, {});

  it('creates one-time links: SINGLE is 1 location, MULTI starts at 3, the token is shown once', async () => {
    await expect(invite({ plan_tier: 'SINGLE', max_locations: 4 })).resolves.toMatchObject({ plan_tier: 'SINGLE', max_locations: 1 });
    const multiInvite = await invite();
    expect(multiInvite).toMatchObject({ max_locations: 3, note: 'Cliente de prueba', used_at: null, token: expect.stringMatching(/^[\w-]{43}$/) });
    const listed = (await call('GET', '/platform/invitations')).body.find((i: { id: string }) => i.id === multiInvite.id);
    expect(listed).not.toHaveProperty('token');
    expect(listed).not.toHaveProperty('token_hash');
    expect((await db.invitations.findUniqueOrThrow({ where: { id: multiInvite.id } })).token_hash).not.toBe(multiInvite.token);
    expect((await call('POST', '/platform/invitations', { plan_tier: 'GOLD' })).status).toBe(400);
    expect((await call('POST', '/platform/invitations', { plan_tier: 'MULTI' }, {})).status).toBe(401);
  });

  it('signs up business + first location + owner in one go, logs in and spends the link', async () => {
    const { token } = await invite({ plan_tier: 'MULTI', max_locations: 4 });
    await expect(call('GET', `/auth/register/${token}`, undefined, {})).resolves.toMatchObject({
      status: 200,
      body: { plan_tier: 'MULTI', max_locations: 4 },
    });

    const body = registration();
    const res = await register(token, body);
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/^pm_refresh=.+HttpOnly; SameSite=Strict/);
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${res.body.access_token}` } }).then((r) => r.json());
    expect(me).toMatchObject({
      user: { full_name: 'Darío Gómez', email: body.email, role: 'OWNER' },
      organization: { name: 'Pizzería Darío', handle: body.handle, plan_tier: 'MULTI', max_locations: 4 },
      locations: [{ name: 'Sede Centro', city: 'Medellín' }],
    });
    const owner = await db.users.findUniqueOrThrow({ where: { email: body.email }, include: { organizations: true } });
    expect(owner.phone).toBe('+57 300 000 0000');
    expect(owner.organizations.nit).toBeNull();
    // The password is kept as typed (spaces included), like login reads it.
    expect((await call('POST', '/auth/login', { email: body.email, password: ' una clave larga ' }, {})).status).toBe(200);

    expect((await call('GET', `/auth/register/${token}`, undefined, {})).status).toBe(404);
    expect((await register(token)).status).toBe(404);
    const used = (await call('GET', '/platform/invitations')).body.find(
      (i: { organizations: { handle: string } | null }) => i.organizations?.handle === body.handle,
    );
    expect(used.used_at).toEqual(expect.any(String));
  });

  it('refuses a taken, reserved or invalid handle and a taken email, and the link stays usable', async () => {
    const { token } = await invite();
    const first = registration();
    expect((await register((await invite()).token, first)).status).toBe(200);

    for (const handle of [first.handle.toUpperCase(), 'App', 'cafe_ejemplo']) {
      const res = await register(token, registration({ handle }));
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('identificador');
    }
    const email = await register(token, registration({ email: first.email.toUpperCase() }));
    expect(email.status).toBe(409);
    expect(email.body.message).toContain('correo');
    for (const bad of [{ handle: 'con-guion' }, { handle: '@arroba' }, { handle: 'ab' }, { password: 'corta' }, { address: ' ' }, { password: 1 }]) {
      expect((await register(token, registration(bad))).status).toBe(400);
    }
    expect((await register(token)).status).toBe(200);
  });

  it('only one of two simultaneous sign-ups with the same link wins', async () => {
    const { token } = await invite();
    const results = await Promise.all([register(token), register(token)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 404]);
  });

  it('expired, revoked and unknown links do not work', async () => {
    const expired = await invite();
    await db.invitations.update({ where: { id: expired.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect((await register(expired.token)).status).toBe(404);
    expect((await call('GET', '/auth/register/no-existe', undefined, {})).body.message).toContain('Pídele una nueva');

    const revoked = await invite();
    await expect(call('POST', `/platform/invitations/${revoked.id}/revoke`)).resolves.toMatchObject({
      status: 200,
      body: { revoked_at: expect.any(String) },
    });
    expect((await register(revoked.token)).status).toBe(404);
  });

  it('regenerates a link with the same plan and revokes the old one; a used link can be neither', async () => {
    const old = await invite({ plan_tier: 'MULTI', max_locations: 5, note: 'Regenerar' });
    const res = await call('POST', `/platform/invitations/${old.id}/regenerate`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ plan_tier: 'MULTI', max_locations: 5, note: 'Regenerar', revoked_at: null });
    expect(res.body.token).not.toBe(old.token);
    expect((await register(old.token)).status).toBe(404);
    expect((await register(res.body.token)).status).toBe(200);

    expect((await call('POST', `/platform/invitations/${res.body.id}/revoke`)).status).toBe(409);
    expect((await call('POST', `/platform/invitations/${res.body.id}/regenerate`)).status).toBe(409);
    expect((await call('POST', `/platform/invitations/${randomUUID()}/revoke`)).status).toBe(404);
  });
});
