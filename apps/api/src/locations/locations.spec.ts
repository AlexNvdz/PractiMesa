// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let single: TestOrg;
let multi: TestOrg;
let race: TestOrg;

beforeAll(async () => {
  app = await startApp();
  single = await createOrg(db, 'SINGLE', 1);
  multi = await createOrg(db, 'MULTI', 1);
  race = await createOrg(db, 'MULTI', 1);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [single.id, multi.id, race.id] } } });
  await db.$disconnect();
  await app.close();
});

const newLocation = { name: 'Norte', city: 'Bogotá', address: 'Calle 100' };

describe('locations', () => {
  it('lists only the caller organization locations', async () => {
    const api = await client(app, multi.users.OWNER);
    const res = await api('GET', '/locations');
    expect(res.status).toBe(200);
    expect(res.body.map((l: { id: string }) => l.id)).toEqual(multi.locations);
  });

  it('is restricted to the owner', async () => {
    const api = await client(app, multi.users.ADMIN);
    expect((await api('GET', '/locations')).status).toBe(403);
    expect((await api('POST', '/locations', newLocation)).status).toBe(403);
  });

  it('blocks a 2nd location on SINGLE', async () => {
    const api = await client(app, single.users.OWNER);
    const res = await api('POST', '/locations', newLocation);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('1 sede');
  });

  it('creates a location on MULTI in the caller organization, ignoring organization_id from the body', async () => {
    const api = await client(app, multi.users.OWNER);
    const res = await api('POST', '/locations', { ...newLocation, name: '  Norte ', organization_id: single.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Norte', organization_id: multi.id, is_active: true });
  });

  it('validates the body', async () => {
    const api = await client(app, multi.users.OWNER);
    expect((await api('POST', '/locations', { name: 'Sur', city: 'Cali' })).status).toBe(400);
    expect((await api('POST', '/locations', { ...newLocation, phone_whatsapp: 3001234567 })).status).toBe(400);
  });

  it('re-checks the limit inside the transaction under concurrent creates', async () => {
    const api = await client(app, race.users.OWNER);
    const statuses = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/locations', newLocation)));
    expect(statuses.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 201, 403, 403, 403]);
    await expect(db.locations.count({ where: { organization_id: race.id } })).resolves.toBe(3);
  });

  it('updates a location and hides other organizations ones (404)', async () => {
    const api = await client(app, multi.users.OWNER);
    const res = await api('PATCH', `/locations/${multi.locations[0]}`, { is_active: false, phone_whatsapp: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ is_active: false, phone_whatsapp: null });
    expect((await api('PATCH', `/locations/${single.locations[0]}`, { name: 'x' })).status).toBe(404);
    expect((await api('PATCH', '/locations/not-a-uuid', { name: 'x' })).status).toBe(400);
  });

  it('deletes a location without history, never the last one or one with orders', async () => {
    const owner = await client(app, single.users.OWNER);
    expect((await owner('DELETE', `/locations/${single.locations[0]}`)).status).toBe(409);
    expect((await owner('DELETE', `/locations/${race.locations[0]}`)).status).toBe(404);

    const api = await client(app, race.users.OWNER);
    await db.orders.create({
      data: {
        organization_id: race.id,
        location_id: race.locations[0],
        channel: 'POS',
        order_type: 'PICKUP',
        subtotal_cop: 1000,
        tax_cop: 80,
        total_cop: 1080,
      },
    });
    expect((await api('DELETE', `/locations/${race.locations[0]}`)).status).toBe(409);

    const extra = await db.locations.findFirstOrThrow({ where: { organization_id: race.id, id: { not: race.locations[0] } } });
    expect((await api('DELETE', `/locations/${extra.id}`)).status).toBe(204);
    await expect(db.locations.count({ where: { organization_id: race.id } })).resolves.toBe(2);
  });
});
