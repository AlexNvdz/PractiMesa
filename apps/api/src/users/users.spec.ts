// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../auth/password';
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

  it('validates: PIN required, username format and uniqueness; email is never stored', async () => {
    const owner = await client(app, multi.users.OWNER);
    expect((await owner('POST', '/users', worker({ pin: undefined }))).status).toBe(400);
    for (const bad of [{ username: 'Alex' }, { username: 'al' }, { username: 'alex-n' }, { pin: '12a4' }, { pin: '123' }, { role: 'OWNER' }]) {
      expect((await owner('POST', '/users', worker(bad))).status).toBe(400);
    }
    expect((await owner('POST', '/users', worker({ location_ids: [randomUUID()] }))).status).toBe(400);
    const withEmail = await owner('POST', '/users', worker({ email: 'x@test.demo', password: 'clave-larga' }));
    expect(withEmail.status).toBe(201);
    expect(withEmail.body.email).toBeNull();
    const first = worker();
    expect((await owner('POST', '/users', first)).status).toBe(201);
    const dup = await owner('POST', '/users', worker({ username: first.username }));
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain('usuario ya existe');
  });

  it('creates a supervisor with username + PIN, like everyone but the owner', async () => {
    const owner = await client(app, multi.users.OWNER);
    expect((await owner('POST', '/users', worker({ role: 'ADMIN', pin: undefined }))).status).toBe(400);
    const res = await owner('POST', '/users', worker({ role: 'ADMIN', location_ids: [multi.locations[0]] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'ADMIN', email: null, has_pin: true });
  });

  it('changes role, locations and state', async () => {
    const owner = await client(app, multi.users.OWNER);
    const { body: created } = await owner('POST', '/users', worker());
    const promoted = await owner('PATCH', `/users/${created.id}`, { role: 'ADMIN' });
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

  it('the owner is listed but its data changes only in Mi cuenta', async () => {
    const owner = await client(app, multi.users.OWNER);
    const listed = (await owner('GET', '/users')).body as { id: string; role: string }[];
    expect(listed.map((u) => u.id)).toEqual(expect.arrayContaining([multi.users.OWNER, multi.users.ADMIN]));
    for (const body of [{ given_names: 'Otra' }, { role: 'ADMIN' }, { is_active: false }]) {
      const res = await owner('PATCH', `/users/${multi.users.OWNER}`, body);
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('Mi cuenta');
    }
    expect((await owner('PUT', `/users/${multi.users.OWNER}/pin`, { pin: '987654' })).status).toBe(403);
  });
});

describe('team access', () => {
  it('is only for the owner: closed to supervisors, workers and other businesses', async () => {
    for (const id of [multi.users.ADMIN, multi.users.CASHIER]) {
      const user = await client(app, id);
      expect((await user('GET', '/users')).status).toBe(403);
      expect((await user('PUT', `/users/${multi.users.CASHIER}/pin`, { pin: '1111' })).status).toBe(403);
    }
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

describe('mi cuenta (/me)', () => {
  it('anyone changes its own PIN; the current one is asked and wrong ones count toward the lockout', async () => {
    const owner = await client(app, multi.users.OWNER);
    const { body: created } = await owner('POST', '/users', worker());
    const me = await client(app, created.id);
    expect((await me('PUT', '/me/pin', { pin: '5678' })).status).toBe(400);
    const wrong = await me('PUT', '/me/pin', { current_pin: '0000', pin: '5678' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toContain('PIN actual');
    expect((await db.users.findUniqueOrThrow({ where: { id: created.id } })).pin_failed_count).toBe(1);
    expect((await me('PUT', '/me/pin', { current_pin: '1234', pin: '5678' })).status).toBe(204);
    const stored = await db.users.findUniqueOrThrow({ where: { id: created.id } });
    await expect(verifyPassword('5678', stored.pin_hash!)).resolves.toBe(true);
    expect(stored.pin_failed_count).toBe(0);
  });

  it('a user without PIN creates one without a current PIN', async () => {
    await db.users.update({ where: { id: single.users.OWNER }, data: { pin_hash: null } });
    const owner = await client(app, single.users.OWNER);
    expect((await owner('PUT', '/me/pin', { pin: '2468' })).status).toBe(204);
  });

  it('the owner changes its names without a password', async () => {
    const owner = await client(app, single.users.OWNER);
    const res = await owner('PATCH', '/me', { given_names: 'Dueña', family_names: 'Prueba' });
    expect(res.status).toBe(200);
    expect(res.body.full_name).toBe('Dueña Prueba');
  });

  it('the owner changes its username, email and password with the current password', async () => {
    const hash = await hashPassword('clave-actual');
    await db.users.update({ where: { id: single.users.OWNER }, data: { password_hash: hash } });
    const owner = await client(app, single.users.OWNER);
    expect((await owner('PATCH', '/me', { username: 'dueno.nuevo' })).status).toBe(400);
    expect((await owner('PATCH', '/me', { username: 'dueno.nuevo', current_password: 'otra' })).status).toBe(400);
    const taken = await db.users.findUniqueOrThrow({ where: { id: multi.users.OWNER } });
    expect((await owner('PATCH', '/me', { email: taken.email, current_password: 'clave-actual' })).status).toBe(409);
    expect((await owner('PATCH', '/me', { password: 'corta', current_password: 'clave-actual' })).status).toBe(400);
    const email = `nuevo-${randomUUID().slice(0, 8)}@test.demo`;
    const res = await owner('PATCH', '/me', { username: 'dueno.nuevo', email: email.toUpperCase(), password: 'clave nueva larga', current_password: 'clave-actual' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: 'dueno.nuevo', email });
    const stored = await db.users.findUniqueOrThrow({ where: { id: single.users.OWNER } });
    await expect(verifyPassword('clave nueva larga', stored.password_hash!)).resolves.toBe(true);

    const cashier = await client(app, single.users.CASHIER);
    expect((await cashier('PATCH', '/me', { username: 'caja.x', current_password: 'x' })).status).toBe(403);
  });
});
