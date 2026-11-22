// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let base: string;
let multi: TestOrg;
let other: TestOrg;
let handle: string;
let cashierHere: string;

type Res = { status: number; body: any; cookies: Record<string, string>; setCookie: string | null };

/** Raw HTTP call with cookies, as the browser behind the web proxy does it. */
async function call(method: string, path: string, body?: unknown, cookies: Record<string, string> = {}, bearer?: string): Promise<Res> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const set = res.headers.getSetCookie();
  const cookiesOut = Object.fromEntries(set.map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]));
  return { status: res.status, body: text ? JSON.parse(text) : undefined, cookies: cookiesOut, setCookie: set.join('\n') || null };
}

const ownerToken = () => app.get(JwtService).signAsync({ sub: multi.users.OWNER });

/** Authorizes a new device at the location as the owner; returns its id and cookie. */
async function authorize(locationId: string, name = 'Caja 1', previous?: string) {
  const res = await call('POST', '/devices', { name, location_id: locationId }, previous ? { pm_device: previous } : {}, await ownerToken());
  expect(res.status).toBe(201);
  return { id: res.body.id as string, cookie: res.cookies.pm_device, res };
}

const pin = (device: string | undefined, body: object) => call('POST', '/auth/pin', body, device ? { pm_device: device } : {});

beforeAll(async () => {
  app = await startApp();
  base = await app.getUrl();
  multi = await createOrg(db, 'MULTI', 2);
  other = await createOrg(db, 'SINGLE', 1);
  const org = await db.organizations.findUniqueOrThrow({ where: { id: multi.id } });
  handle = org.handle;
  const pinHash = await hashPassword('1234');
  await db.users.update({ where: { id: multi.users.CASHIER }, data: { username: 'caja.uno', pin_hash: pinHash, allowed_location_ids: [multi.locations[0]] } });
  cashierHere = multi.users.CASHIER;
  await db.users.create({
    data: { organization_id: multi.id, full_name: 'Otra Sede', username: 'caja.dos', pin_hash: pinHash, role: 'CASHIER', allowed_location_ids: [multi.locations[1]] },
  });
  await db.users.update({ where: { id: multi.users.ADMIN }, data: { allowed_location_ids: [multi.locations[0]] } });
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [multi.id, other.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('login step 1: business', () => {
  it('finds the business by handle ignoring case, with its locations and no device', async () => {
    const res = await call('GET', `/auth/business/${handle.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handle, plan_tier: 'MULTI', device: null });
    expect(res.body.locations).toHaveLength(2);
    expect((await call('GET', '/auth/business/no_existe_123')).status).toBe(404);
    expect((await call('GET', '/auth/business/con-guion')).status).toBe(404);
  });
});

describe('devices', () => {
  it('authorizes this browser with a long httpOnly cookie and never returns the token', async () => {
    const { cookie, res } = await authorize(multi.locations[0]);
    expect(res.setCookie).toMatch(/^pm_device=.+; Max-Age=31536000; Path=\/api; Expires=.+; HttpOnly; SameSite=Strict$/);
    expect(res.body).toMatchObject({ name: 'Caja 1', location_id: multi.locations[0], current: true, locations: { name: 'Sede 1' } });
    expect(res.body).not.toHaveProperty('token_hash');
    const stored = await db.devices.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.token_hash).not.toBe(cookie);

    const step1 = await call('GET', `/auth/business/${handle}`, undefined, { pm_device: cookie });
    expect(step1.body.device).toMatchObject({ id: res.body.id, name: 'Caja 1', location: { id: multi.locations[0], name: 'Sede 1' } });
    // Another business does not see this browser's device.
    const otherHandle = (await db.organizations.findUniqueOrThrow({ where: { id: other.id } })).handle;
    expect((await call('GET', `/auth/business/${otherHandle}`, undefined, { pm_device: cookie })).body.device).toBeNull();
  });

  it('needs a location the caller works in (MULTI)', async () => {
    const owner = await ownerToken();
    expect((await call('POST', '/devices', { name: 'Sin sede' }, {}, owner)).status).toBe(400);
    const admin = await app.get(JwtService).signAsync({ sub: multi.users.ADMIN });
    expect((await call('POST', '/devices', { name: 'Otra', location_id: multi.locations[1] }, {}, admin)).status).toBe(400);
    const cashier = await app.get(JwtService).signAsync({ sub: multi.users.CASHIER });
    expect((await call('POST', '/devices', { name: 'Caja', location_id: multi.locations[0] }, {}, cashier)).status).toBe(403);
  });

  it('re-authorizing a browser revokes its previous device', async () => {
    const first = await authorize(multi.locations[0], 'Vieja');
    const second = await authorize(multi.locations[0], 'Nueva', first.cookie);
    expect((await db.devices.findUniqueOrThrow({ where: { id: first.id } })).revoked_at).not.toBeNull();
    expect((await db.devices.findUniqueOrThrow({ where: { id: second.id } })).revoked_at).toBeNull();
  });

  it('admins list and revoke only devices of their locations', async () => {
    const here = await authorize(multi.locations[0], 'Aquí');
    const there = await authorize(multi.locations[1], 'Allá');
    const admin = await app.get(JwtService).signAsync({ sub: multi.users.ADMIN });
    const list = await call('GET', '/devices', undefined, { pm_device: here.cookie }, admin);
    const ids = list.body.map((d: { id: string }) => d.id);
    expect(ids).toContain(here.id);
    expect(ids).not.toContain(there.id);
    expect(list.body.find((d: { id: string }) => d.id === here.id).current).toBe(true);
    expect(list.body.every((d: object) => !('token_hash' in d))).toBe(true);
    expect((await call('POST', `/devices/${there.id}/revoke`, undefined, {}, admin)).status).toBe(403);
    expect((await call('POST', `/devices/${here.id}/revoke`, undefined, {}, admin)).status).toBe(204);
    const stranger = await app.get(JwtService).signAsync({ sub: other.users.OWNER });
    expect((await call('POST', `/devices/${there.id}/revoke`, undefined, {}, stranger)).status).toBe(404);
  });
});

describe('PIN login', () => {
  it('signs a worker in on the device, bound to its location', async () => {
    const { id, cookie } = await authorize(multi.locations[0]);
    const res = await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '1234' });
    expect(res.status).toBe(200);
    expect(res.cookies.pm_refresh).toBeDefined();
    const claims = await app.get(JwtService).verifyAsync(res.body.access_token);
    expect(claims).toMatchObject({ sub: cashierHere, dev: id });

    const me = await call('GET', '/me', undefined, {}, res.body.access_token);
    expect(me.body).toMatchObject({ device: { id, name: 'Caja 1' }, current_location_id: multi.locations[0] });
    expect(me.body.locations.map((l: { id: string }) => l.id)).toEqual([multi.locations[0]]);
    expect((await db.devices.findUniqueOrThrow({ where: { id } })).last_used_at).not.toBeNull();
  });

  it('answers the same for unknown user, other role, other location or wrong PIN', async () => {
    const { cookie } = await authorize(multi.locations[0]);
    for (const body of [
      { role: 'CASHIER', username: 'nadie.aqui', pin: '1234' },
      { role: 'WAITER', username: 'caja.uno', pin: '1234' },
      { role: 'CASHIER', username: 'caja.dos', pin: '1234' },
      { role: 'CASHIER', username: 'caja.uno', pin: '9999' },
    ]) {
      const res = await pin(cookie, body);
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Usuario o PIN incorrecto');
    }
    await db.users.update({ where: { id: cashierHere }, data: { pin_failed_count: 0 } });
    expect((await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '12' })).status).toBe(400);
  });

  it('needs an authorized device', async () => {
    const res = await pin(undefined, { role: 'CASHIER', username: 'caja.uno', pin: '1234' });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('no está autorizado');
    expect((await pin('token-inventado', { role: 'CASHIER', username: 'caja.uno', pin: '1234' })).status).toBe(401);
  });

  it('locks the user for 5 minutes after 5 wrong PINs', async () => {
    const { cookie } = await authorize(multi.locations[0]);
    for (let i = 0; i < 5; i++) expect((await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '0000' })).status).toBe(401);
    const locked = await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '1234' });
    expect(locked.status).toBe(429);
    expect(locked.body.message).toContain('5 minutos');
    await db.users.update({ where: { id: cashierHere }, data: { pin_locked_until: new Date(Date.now() - 1000) } });
    expect((await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '1234' })).status).toBe(200);
    expect((await db.users.findUniqueOrThrow({ where: { id: cashierHere } })).pin_locked_until).toBeNull();
  });

  it('revoking the device ends its sessions at once and closes the PIN door', async () => {
    const { id, cookie } = await authorize(multi.locations[0]);
    const session = await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '1234' });
    expect((await call('POST', `/devices/${id}/revoke`, undefined, {}, await ownerToken())).status).toBe(204);
    expect((await call('GET', '/me', undefined, {}, session.body.access_token)).status).toBe(401);
    expect((await call('POST', '/auth/refresh', undefined, { pm_refresh: session.cookies.pm_refresh })).status).toBe(401);
    expect((await call('GET', `/auth/business/${handle}`, undefined, { pm_device: cookie })).body.device).toBeNull();
    expect((await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '1234' })).status).toBe(401);
  });

  it('a PIN session refreshes on its device and keeps the device claim', async () => {
    const { id, cookie } = await authorize(multi.locations[0]);
    const session = await pin(cookie, { role: 'CASHIER', username: 'caja.uno', pin: '1234' });
    const refreshed = await call('POST', '/auth/refresh', undefined, { pm_refresh: session.cookies.pm_refresh });
    expect(refreshed.status).toBe(200);
    await expect(app.get(JwtService).verifyAsync(refreshed.body.access_token)).resolves.toMatchObject({ dev: id });
  });
});

describe('email login (Q32)', () => {
  it('is for owners and admins, and a typed handle must be their business', async () => {
    const owner = await db.users.update({ where: { id: multi.users.OWNER }, data: { password_hash: await hashPassword('clave-dueno') } });
    const cashier = await db.users.update({ where: { id: multi.users.CASHIER }, data: { password_hash: await hashPassword('clave-caja') } });
    expect((await call('POST', '/auth/login', { email: owner.email, password: 'clave-dueno', handle: handle.toUpperCase() })).status).toBe(200);
    expect((await call('POST', '/auth/login', { email: owner.email, password: 'clave-dueno', handle: 'otro_negocio' })).status).toBe(401);
    expect((await call('POST', '/auth/login', { email: owner.email, password: 'clave-dueno', handle: 'con-guion' })).status).toBe(400);
    const worker = await call('POST', '/auth/login', { email: cashier.email, password: 'clave-caja' });
    expect(worker.status).toBe(403);
    expect(worker.body.message).toContain('usuario y PIN');
  });

  it('workers cannot see devices', async () => {
    const cashier = await client(app, multi.users.CASHIER);
    expect((await cashier('GET', '/devices')).status).toBe(403);
  });
});
