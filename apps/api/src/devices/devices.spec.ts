// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password';
import { sha256 } from '../auth/auth.service';
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

/** Owner generates a link code for the location; returns the code. */
async function newCode(locationId: string, name = 'Caja 1') {
  const res = await call('POST', '/devices/codes', { name, location_id: locationId }, {}, await ownerToken());
  expect(res.status).toBe(201);
  return res.body.code as string;
}

/** Links a browser at the location (code + handle); returns the device id and cookie. */
async function link(locationId: string, name = 'Caja 1', previous?: string) {
  const code = await newCode(locationId, name);
  const res = await call('POST', '/auth/device', { handle, code }, previous ? { pm_device: previous } : {});
  expect(res.status).toBe(200);
  return { id: res.body.id as string, cookie: res.cookies.pm_device, res };
}

/** Linked device written straight to the DB (the link endpoint is throttled per business). */
async function linked(locationId: string) {
  const cookie = randomBytes(32).toString('base64url');
  const { id } = await db.devices.create({
    data: { organization_id: multi.id, location_id: locationId, name: 'Caja 1', token_hash: sha256(cookie), created_by: multi.users.OWNER },
  });
  return { id, cookie };
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
  await db.users.update({ where: { id: multi.users.ADMIN }, data: { username: 'super.uno', pin_hash: pinHash, allowed_location_ids: [multi.locations[0]] } });
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [multi.id, other.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('login step 1: business', () => {
  it('finds the business by handle ignoring case, without this browser linked', async () => {
    const res = await call('GET', `/auth/business/${handle.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handle, name: expect.any(String), device: null });
    expect((await call('GET', '/auth/business/no_existe_123')).status).toBe(404);
    expect((await call('GET', '/auth/business/con-guion')).status).toBe(404);
  });
});

describe('link codes', () => {
  it('only the owner generates them, at an active location of the business', async () => {
    const owner = await ownerToken();
    expect((await call('POST', '/devices/codes', { name: 'Sin sede' }, {}, owner)).status).toBe(400);
    expect((await call('POST', '/devices/codes', { name: 'Otra', location_id: other.locations[0] }, {}, owner)).status).toBe(400);
    for (const id of [multi.users.ADMIN, multi.users.CASHIER]) {
      const token = await app.get(JwtService).signAsync({ sub: id });
      expect((await call('POST', '/devices/codes', { name: 'Caja', location_id: multi.locations[0] }, {}, token)).status).toBe(403);
    }
    const res = await call('POST', '/devices/codes', { name: 'Caja', location_id: multi.locations[0] }, {}, owner);
    expect(res.body.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(new Date(res.body.expires_at).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(await db.device_codes.count({ where: { code_hash: res.body.code } })).toBe(0);
  });

  it('links this browser with a long httpOnly cookie, at the code location and name', async () => {
    const { id, cookie, res } = await link(multi.locations[0], 'Tablet salón');
    expect(res.setCookie).toMatch(/^pm_device=.+; Max-Age=31536000; Path=\/api; Expires=.+; HttpOnly; SameSite=Strict$/);
    expect(res.body).toEqual({ id, name: 'Tablet salón', location: { id: multi.locations[0], name: 'Sede 1' } });
    const stored = await db.devices.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ location_id: multi.locations[0], created_by: multi.users.OWNER });
    expect(stored.token_hash).not.toBe(cookie);

    const step1 = await call('GET', `/auth/business/${handle}`, undefined, { pm_device: cookie });
    expect(step1.body.device).toMatchObject({ id, name: 'Tablet salón', location: { id: multi.locations[0] } });
    // Another business does not see this browser's device.
    const otherHandle = (await db.organizations.findUniqueOrThrow({ where: { id: other.id } })).handle;
    expect((await call('GET', `/auth/business/${otherHandle}`, undefined, { pm_device: cookie })).body.device).toBeNull();
  });

  it('a code works once, ignores case and dashes, and only for its business while not expired', async () => {
    const code = await newCode(multi.locations[0]);
    const otherHandle = (await db.organizations.findUniqueOrThrow({ where: { id: other.id } })).handle;
    const wrongBusiness = await call('POST', '/auth/device', { handle: otherHandle, code });
    expect(wrongBusiness.status).toBe(401);
    expect(wrongBusiness.body.message).toContain('Código incorrecto');
    expect((await call('POST', '/auth/device', { handle, code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` })).status).toBe(200);
    expect((await call('POST', '/auth/device', { handle, code })).status).toBe(401);

    const late = await newCode(multi.locations[0]);
    await db.device_codes.updateMany({ where: { organization_id: multi.id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect((await call('POST', '/auth/device', { handle, code: late })).status).toBe(401);
    expect((await call('POST', '/auth/device', { handle: 'no_existe_123', code: late })).status).toBe(404);
  });

  it('linking a browser again deletes its previous device', async () => {
    const first = await link(multi.locations[0], 'Vieja');
    const second = await link(multi.locations[1], 'Nueva', first.cookie);
    expect(await db.devices.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await db.devices.findUnique({ where: { id: second.id } })).not.toBeNull();
  });
});

describe('devices', () => {
  it('the owner lists them (marking this browser) and unlinks them; nobody else', async () => {
    const here = await link(multi.locations[0], 'Aquí');
    const owner = await ownerToken();
    const list = await call('GET', '/devices', undefined, { pm_device: here.cookie }, owner);
    expect(list.body.find((d: { id: string }) => d.id === here.id)).toMatchObject({ current: true, locations: { name: 'Sede 1' } });
    expect(list.body.every((d: object) => !('token_hash' in d))).toBe(true);

    const admin = await app.get(JwtService).signAsync({ sub: multi.users.ADMIN });
    expect((await call('GET', '/devices', undefined, {}, admin)).status).toBe(403);
    expect((await call('DELETE', `/devices/${here.id}`, undefined, {}, admin)).status).toBe(403);
    const stranger = await app.get(JwtService).signAsync({ sub: other.users.OWNER });
    expect((await call('DELETE', `/devices/${here.id}`, undefined, {}, stranger)).status).toBe(404);
    expect((await call('DELETE', `/devices/${here.id}`, undefined, {}, owner)).status).toBe(204);
    expect(await db.devices.findUnique({ where: { id: here.id } })).toBeNull();
  });
});

describe('PIN login', () => {
  it('signs a worker in on the device, bound to its location', async () => {
    const { id, cookie } = await linked(multi.locations[0]);
    const res = await pin(cookie, { username: 'caja.uno', pin: '1234' });
    expect(res.status).toBe(200);
    expect(res.cookies.pm_refresh).toBeDefined();
    const claims = await app.get(JwtService).verifyAsync(res.body.access_token);
    expect(claims).toMatchObject({ sub: cashierHere, dev: id });

    const me = await call('GET', '/me', undefined, {}, res.body.access_token);
    expect(me.body).toMatchObject({ device: { id, name: 'Caja 1' }, current_location_id: multi.locations[0] });
    expect(me.body.locations.map((l: { id: string }) => l.id)).toEqual([multi.locations[0]]);
    expect((await db.devices.findUniqueOrThrow({ where: { id } })).last_used_at).not.toBeNull();
  });

  it('answers the same for unknown user, other location or wrong PIN', async () => {
    const { cookie } = await linked(multi.locations[0]);
    for (const body of [
      { username: 'nadie.aqui', pin: '1234' },
      { username: 'caja.dos', pin: '1234' },
      { username: 'caja.uno', pin: '9999' },
    ]) {
      const res = await pin(cookie, body);
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Usuario o PIN incorrecto');
    }
    await db.users.update({ where: { id: cashierHere }, data: { pin_failed_count: 0 } });
    expect((await pin(cookie, { username: 'caja.uno', pin: '12' })).status).toBe(400);
  });

  it('needs an authorized device', async () => {
    const res = await pin(undefined, { username: 'caja.uno', pin: '1234' });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('no está vinculado');
    expect((await pin('token-inventado', { username: 'caja.uno', pin: '1234' })).status).toBe(401);
  });

  it('locks the user for 5 minutes after 5 wrong PINs', async () => {
    const { cookie } = await linked(multi.locations[0]);
    for (let i = 0; i < 5; i++) expect((await pin(cookie, { username: 'caja.uno', pin: '0000' })).status).toBe(401);
    const locked = await pin(cookie, { username: 'caja.uno', pin: '1234' });
    expect(locked.status).toBe(429);
    expect(locked.body.message).toContain('5 minutos');
    await db.users.update({ where: { id: cashierHere }, data: { pin_locked_until: new Date(Date.now() - 1000) } });
    expect((await pin(cookie, { username: 'caja.uno', pin: '1234' })).status).toBe(200);
    expect((await db.users.findUniqueOrThrow({ where: { id: cashierHere } })).pin_locked_until).toBeNull();
  });

  it('unlinking the device ends its sessions at once and closes the PIN door', async () => {
    const { id, cookie } = await linked(multi.locations[0]);
    const session = await pin(cookie, { username: 'caja.uno', pin: '1234' });
    expect((await call('DELETE', `/devices/${id}`, undefined, {}, await ownerToken())).status).toBe(204);
    expect((await call('GET', '/me', undefined, {}, session.body.access_token)).status).toBe(401);
    expect((await call('POST', '/auth/refresh', undefined, { pm_refresh: session.cookies.pm_refresh })).status).toBe(401);
    expect((await call('GET', `/auth/business/${handle}`, undefined, { pm_device: cookie })).body.device).toBeNull();
    expect((await pin(cookie, { username: 'caja.uno', pin: '1234' })).status).toBe(401);
  });

  it('supervisors sign in with PIN too; the role comes from the user', async () => {
    const { cookie } = await linked(multi.locations[0]);
    const res = await pin(cookie, { username: 'super.uno', pin: '1234' });
    expect(res.status).toBe(200);
    const me = await call('GET', '/me', undefined, {}, res.body.access_token);
    expect(me.body.user).toMatchObject({ role: 'ADMIN', username: 'super.uno', has_pin: true });
  });

  it('a PIN session refreshes on its device and keeps the device claim', async () => {
    const { id, cookie } = await linked(multi.locations[0]);
    const session = await pin(cookie, { username: 'caja.uno', pin: '1234' });
    const refreshed = await call('POST', '/auth/refresh', undefined, { pm_refresh: session.cookies.pm_refresh });
    expect(refreshed.status).toBe(200);
    await expect(app.get(JwtService).verifyAsync(refreshed.body.access_token)).resolves.toMatchObject({ dev: id });
  });
});

describe('email login', () => {
  it('is only for the owner, and a typed handle must be its business', async () => {
    const owner = await db.users.update({ where: { id: multi.users.OWNER }, data: { password_hash: await hashPassword('clave-dueno') } });
    expect((await call('POST', '/auth/login', { email: owner.email, password: 'clave-dueno', handle: handle.toUpperCase() })).status).toBe(200);
    expect((await call('POST', '/auth/login', { email: owner.email, password: 'clave-dueno', handle: 'otro_negocio' })).status).toBe(401);
    expect((await call('POST', '/auth/login', { email: owner.email, password: 'clave-dueno', handle: 'con-guion' })).status).toBe(400);
    for (const id of [multi.users.ADMIN, multi.users.CASHIER]) {
      const user = await db.users.update({ where: { id }, data: { password_hash: await hashPassword('clave-otra') } });
      const res = await call('POST', '/auth/login', { email: user.email, password: 'clave-otra' });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('usuario y PIN');
    }
  });
});
