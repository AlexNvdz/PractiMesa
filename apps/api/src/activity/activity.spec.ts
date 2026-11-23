// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg;
let ownerA1: Call;
let ownerA2: Call;
let cashierA1: Call;
let superA1: Call; // supervisor of location 1 only
let superA2: Call; // the same supervisor asking for location 2
let ownerB: Call;
let coffee: string;

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  const [loc1, loc2] = orgA.locations;
  coffee = (await db.ingredients.create({ data: { organization_id: orgA.id, name: 'Café', unit: 'gr' } })).id;
  const supervisor = await db.users.create({
    data: { organization_id: orgA.id, full_name: 'Supervisora Uno', role: 'ADMIN', username: 'super.uno', allowed_location_ids: [loc1] },
  });
  ownerA1 = await client(app, orgA.users.OWNER, loc1);
  ownerA2 = await client(app, orgA.users.OWNER, loc2);
  cashierA1 = await client(app, orgA.users.CASHIER, loc1);
  superA1 = await client(app, supervisor.id, loc1);
  superA2 = await client(app, supervisor.id, loc2);
  ownerB = await client(app, orgB.users.OWNER);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('activity log', () => {
  it('logs stock received and counted with before and after', async () => {
    expect((await cashierA1('POST', `/location-stock/${coffee}/receive`, { qty: 1000 })).status).toBe(200);
    expect((await cashierA1('POST', `/location-stock/${coffee}/receive`, { qty: 250.5 })).status).toBe(200);
    expect((await cashierA1('PUT', `/location-stock/${coffee}`, { current_qty: 1200 })).body.current_qty).toBe('1200');
    // Changing only the alert minimum is not a count.
    expect((await cashierA1('PUT', `/location-stock/${coffee}`, { min_alert_qty: 100 })).status).toBe(200);

    const { body } = await ownerA1('GET', `/activity?ingredient=${coffee}`);
    expect(body.map((e: { kind: string; details: object }) => [e.kind, e.details])).toEqual([
      ['STOCK_COUNT', { ingredient: 'Café', unit: 'gr', before: '1250.5', after: '1200' }],
      ['STOCK_RECEIVE', { ingredient: 'Café', unit: 'gr', qty: '250.5', before: '1000', after: '1250.5' }],
      ['STOCK_RECEIVE', { ingredient: 'Café', unit: 'gr', qty: '1000', before: '0', after: '1000' }],
    ]);
    expect(body[0].users).toEqual({ full_name: 'CASHIER' });
  });

  it('logs registers opened and closed with the cash difference', async () => {
    const register = (await cashierA1('POST', '/cash-registers', { opening_amount_cop: 50000 })).body.id;
    expect((await cashierA1('POST', `/cash-registers/${register}/close`, { actual_closing_cop: 48000 })).status).toBe(201);
    const { body } = await superA1('GET', '/activity?type=cash');
    expect(body.map((e: { kind: string; details: object }) => [e.kind, e.details])).toEqual([
      ['REGISTER_CLOSE', { register_id: register, expected_cop: '50000', actual_cop: '48000' }],
      ['REGISTER_OPEN', { register_id: register, opening_cop: '50000' }],
    ]);
  });

  it('filters by type, user and date, and pages with a cursor', async () => {
    expect((await ownerA1('GET', '/activity?type=inventory')).body).toHaveLength(3);
    expect((await ownerA1('GET', `/activity?user=${orgA.users.OWNER}`)).body).toEqual([]);
    expect((await ownerA1('GET', `/activity?from=${new Date(Date.now() + 60_000).toISOString()}`)).body).toEqual([]);
    const first = (await ownerA1('GET', '/activity?limit=2')).body;
    expect(first).toHaveLength(2);
    const next = (await ownerA1('GET', `/activity?limit=2&before=${first[1].created_at}`)).body;
    expect(next.map((e: { id: string }) => e.id)).not.toContain(first[1].id);
    expect((await ownerA1('GET', '/activity/users')).body).toEqual([{ id: orgA.users.CASHIER, full_name: 'CASHIER' }]);
    for (const bad of ['type=sales', 'user=nope', 'from=ayer', 'limit=0', 'limit=500']) {
      expect((await ownerA1('GET', `/activity?${bad}`)).status).toBe(400);
    }
  });

  it('is per location, owner and supervisors only, and never leaks across businesses', async () => {
    expect((await ownerA2('GET', '/activity')).body).toEqual([]);
    expect((await superA2('GET', '/activity')).status).toBe(403);
    expect((await cashierA1('GET', '/activity')).status).toBe(403);
    expect((await ownerB('GET', '/activity')).body).toEqual([]);
    expect((await ownerB('GET', '/activity/users')).body).toEqual([]);
  });

  it('is append-only for the app role', async () => {
    const tamper = (sql: string) => db.tenantTransaction(orgA.id, (tx) => tx.$executeRawUnsafe(sql));
    await expect(tamper(`UPDATE activity_log SET details = '{}'`)).rejects.toThrow(/permission denied/);
    await expect(tamper('DELETE FROM activity_log')).rejects.toThrow(/permission denied/);
  });

  it('keeps the history after the ingredient is deleted', async () => {
    expect((await ownerA1('DELETE', `/ingredients/${coffee}`)).status).toBe(204);
    const { body } = await ownerA1('GET', `/activity?ingredient=${coffee}`);
    expect(body).toHaveLength(3);
    expect(body[0].details.ingredient).toBe('Café');
  });
});
