// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let multi: TestOrg;
let single: TestOrg;
let n = 0;

const worker = (overrides: Record<string, unknown> = {}) => {
  n += 1;
  return { given_names: 'Alex Andrés', family_names: 'Navarro Díaz', username: `alex.navarro${n}`, role: 'CASHIER', pin: '1234', ...overrides };
};

beforeAll(async () => {
  app = await startApp();
  multi = await createOrg(db, 'MULTI', 2);
  single = await createOrg(db, 'SINGLE', 1);
  // The admin works only in the first location.
  await db.users.update({ where: { id: multi.users.ADMIN }, data: { allowed_location_ids: [multi.locations[0]] } });
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [multi.id, single.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('team (owner)', () => {
  it('creates a worker with username and PIN, never returning hashes', async () => {
    const owner = await client(app, multi.users.OWNER);
    const body = worker({ location_ids: [multi.locations[1]] });
    const res = await owner('POST', '/users', body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      full_name: 'Alex Andrés Navarro Díaz',
      username: body.username,
      role: 'CASHIER',
      email: null,
      allowed_location_ids: [multi.locations[1]],
      is_active: true,
      has_pin: true,
    });
    expect(res.body).not.toHaveProperty('pin_hash');
    expect(res.body).not.toHaveProperty('password_hash');
    const stored = await db.users.findUniqueOrThrow({ where: { id: res.body.id } });
    await expect(verifyPassword('1234', stored.pin_hash!)).resolves.toBe(true);

    const list = await owner('GET', '/users');
    expect(list.status).toBe(200);
    expect(list.body.map((u: { id: string }) => u.id)).toContain(res.body.id);
    expect(list.body.every((u: object) => !('pin_hash' in u) && !('password_hash' in u))).toBe(true);
  });

  it('validates workers: PIN required, no email, username format and uniqueness', async () => {
    const owner = await client(app, multi.users.OWNER);
    expect((await owner('POST', '/users', worker({ pin: undefined }))).status).toBe(400);
    expect((await owner('POST', '/users', worker({ email: 'x@test.demo' }))).status).toBe(400);
    for (const bad of [{ username: 'Alex' }, { username: 'al' }, { username: 'alex-n' }, { pin: '12a4' }, { pin: '123' }, { role: 'OWNER' }]) {
      expect((await owner('POST', '/users', worker(bad))).status).toBe(400);
    }
    expect((await owner('POST', '/users', worker({ location_ids: [randomUUID()] }))).status).toBe(400);
    const first = worker();
    expect((await owner('POST', '/users', first)).status).toBe(201);
    const dup = await owner('POST', '/users', worker({ username: first.username }));
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain('usuario ya existe');
  });

  it('creates an admin with email and password, who can then log in', async () => {
    const owner = await client(app, multi.users.OWNER);
    const email = `admin-${randomUUID().slice(0, 8)}@test.demo`;
    expect((await owner('POST', '/users', worker({ role: 'ADMIN', pin: undefined }))).status).toBe(400);
    const taken = await owner('POST', '/users', worker({ role: 'ADMIN', email: (await db.users.findUniqueOrThrow({ where: { id: multi.users.OWNER } })).email, password: 'clave-larga' }));
    expect(taken.status).toBe(409);
    expect(taken.body.message).toContain('correo');

    const res = await owner('POST', '/users', worker({ role: 'ADMIN', email: email.toUpperCase(), password: ' clave larga ', pin: undefined, location_ids: [multi.locations[0]] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'ADMIN', email, has_pin: false });
    const base = await app.getUrl();
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: ' clave larga ' }),
    });
    expect(login.status).toBe(200);
  });

  it('changes role, locations and state; a worker becomes admin only with email and password', async () => {
    const owner = await client(app, multi.users.OWNER);
    const { body: created } = await owner('POST', '/users', worker());
    expect((await owner('PATCH', `/users/${created.id}`, { role: 'ADMIN' })).status).toBe(400);
    const promoted = await owner('PATCH', `/users/${created.id}`, {
      role: 'ADMIN',
      email: `promo-${randomUUID().slice(0, 8)}@test.demo`,
      password: 'otra-clave-larga',
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('ADMIN');

    const renamed = await owner('PATCH', `/users/${created.id}`, { given_names: 'Alex', location_ids: [multi.locations[1]] });
    expect(renamed.body).toMatchObject({ full_name: 'Alex Navarro Díaz', allowed_location_ids: [multi.locations[1]] });
  });

  it('deactivating a user locks it out until it is reactivated', async () => {
    const owner = await client(app, multi.users.OWNER);
    const { body: created } = await owner('POST', '/users', worker());
    const asWorker = await client(app, created.id);
    expect((await asWorker('GET', '/me')).status).toBe(200);
    await expect(owner('PATCH', `/users/${created.id}`, { is_active: false })).resolves.toMatchObject({ status: 200, body: { is_active: false } });
    const denied = await asWorker('GET', '/me');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('desactivado');
    await owner('PATCH', `/users/${created.id}`, { is_active: true });
    expect((await asWorker('GET', '/me')).status).toBe(200);
  });

  it('owners edit their own names, username and PIN but not their role or state', async () => {
    const owner = await client(app, multi.users.OWNER);
    for (const body of [{ role: 'ADMIN' }, { is_active: false }, { location_ids: [multi.locations[0]] }]) {
      expect((await owner('PATCH', `/users/${multi.users.OWNER}`, body)).status).toBe(403);
    }
    await expect(owner('PATCH', `/users/${multi.users.OWNER}`, { given_names: 'Dueña', family_names: 'Prueba', username: 'duena.prueba' })).resolves.toMatchObject({
      status: 200,
      body: { full_name: 'Dueña Prueba', username: 'duena.prueba', role: 'OWNER' },
    });
    expect((await owner('PUT', `/users/${multi.users.OWNER}/pin`, { pin: '987654' })).status).toBe(204);
    expect((await owner('PUT', `/users/${multi.users.OWNER}/pin`, { pin: '98' })).status).toBe(400);
  });
});

describe('team (admin, Q42)', () => {
  it('creates workers only in its own locations and never admins', async () => {
    const admin = await client(app, multi.users.ADMIN);
    expect((await admin('POST', '/users', worker({ location_ids: [multi.locations[1]] }))).status).toBe(400);
    const none = await admin('POST', '/users', worker());
    expect(none.status).toBe(400);
    expect(none.body.message).toContain('al menos una sede');
    expect((await admin('POST', '/users', worker({ role: 'ADMIN', email: 'a@test.demo', password: 'clave-larga', location_ids: [multi.locations[0]] }))).status).toBe(403);
    expect((await admin('POST', '/users', worker({ location_ids: [multi.locations[0]] }))).status).toBe(201);
  });

  it('manages only workers of its locations, and cannot touch the owner, admins or accesses', async () => {
    const owner = await client(app, multi.users.OWNER);
    const admin = await client(app, multi.users.ADMIN);
    const { body: mine } = await admin('POST', '/users', worker({ location_ids: [multi.locations[0]] }));
    const { body: elsewhere } = await owner('POST', '/users', worker({ location_ids: [multi.locations[1]] }));
    const { body: everywhere } = await owner('POST', '/users', worker());

    expect((await admin('PATCH', `/users/${mine.id}`, { role: 'KITCHEN', is_active: false })).status).toBe(200);
    expect((await admin('PUT', `/users/${mine.id}/pin`, { pin: '4321' })).status).toBe(204);
    expect((await admin('PATCH', `/users/${mine.id}`, { role: 'ADMIN' })).status).toBe(403);
    expect((await admin('PATCH', `/users/${mine.id}`, { location_ids: [multi.locations[1]] })).status).toBe(400);
    for (const id of [elsewhere.id, everywhere.id, multi.users.OWNER]) {
      expect((await admin('PATCH', `/users/${id}`, { given_names: 'Otro' })).status).toBe(403);
      expect((await admin('PUT', `/users/${id}/pin`, { pin: '1111' })).status).toBe(403);
    }
    const listed = (await admin('GET', '/users')).body as { id: string; can_manage: boolean }[];
    const can = (id: string) => listed.find((u) => u.id === id)?.can_manage;
    expect([can(mine.id), can(multi.users.ADMIN), can(elsewhere.id), can(everywhere.id), can(multi.users.OWNER)]).toEqual([true, true, false, false, false]);
    // Its own PIN and names, yes; its own email or locations, no.
    expect((await admin('PUT', `/users/${multi.users.ADMIN}/pin`, { pin: '2468' })).status).toBe(204);
    expect((await admin('PATCH', `/users/${multi.users.ADMIN}`, { email: 'nuevo@test.demo' })).status).toBe(403);
    expect((await admin('PATCH', `/users/${multi.users.ADMIN}`, { location_ids: [multi.locations[1]] })).status).toBe(403);
  });
});

describe('team access', () => {
  it('an admin of every location manages workers of every location', async () => {
    const owner = await client(app, multi.users.OWNER);
    const { body: everywhere } = await owner('POST', '/users', worker());
    const { body: allAdmin } = await owner('POST', '/users', worker({ role: 'ADMIN', email: `all-${randomUUID().slice(0, 8)}@test.demo`, password: 'clave-larga', pin: undefined }));
    const admin = await client(app, allAdmin.id);
    expect((await admin('GET', '/users')).body.find((u: { id: string }) => u.id === everywhere.id).can_manage).toBe(true);
    expect((await admin('PUT', `/users/${everywhere.id}/pin`, { pin: '5555' })).status).toBe(204);
  });

  it('is closed to workers and to other businesses', async () => {
    const cashier = await client(app, multi.users.CASHIER);
    expect((await cashier('GET', '/users')).status).toBe(403);
    const other = await client(app, single.users.OWNER);
    expect((await other('PATCH', `/users/${multi.users.CASHIER}`, { given_names: 'X' })).status).toBe(404);
    expect((await other('PUT', `/users/${multi.users.CASHIER}/pin`, { pin: '1234' })).status).toBe(404);
  });

  it('on SINGLE ignores locations (the only one)', async () => {
    const owner = await client(app, single.users.OWNER);
    const res = await owner('POST', '/users', worker({ location_ids: [multi.locations[0]] }));
    expect(res.status).toBe(201);
    expect(res.body.allowed_location_ids).toEqual([]);
  });
});
