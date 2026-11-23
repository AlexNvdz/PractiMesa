// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg; // SINGLE
let adminA1: Call; // admin at location 1
let adminA2: Call; // admin at location 2
let cashierA1: Call;
let waiterA1: Call;
let ownerB: Call;

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  const waiter = await db.users.create({
    data: { organization_id: orgA.id, email: `waiter-${orgA.id}@test.demo`, password_hash: 'x', full_name: 'Mesero', role: 'WAITER' },
  });
  adminA1 = await client(app, orgA.users.ADMIN, orgA.locations[0]);
  adminA2 = await client(app, orgA.users.ADMIN, orgA.locations[1]);
  cashierA1 = await client(app, orgA.users.CASHIER, orgA.locations[0]);
  waiterA1 = await client(app, waiter.id, orgA.locations[0]);
  ownerB = await client(app, orgB.users.OWNER);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
});

const order = (registerId: string, total: number, payment_method: string, payment_status: string) =>
  db.orders.create({
    data: {
      organization_id: orgA.id,
      location_id: orgA.locations[0],
      cash_register_id: registerId,
      channel: 'POS',
      order_type: 'PICKUP',
      subtotal_cop: total,
      tax_cop: 0,
      total_cop: total,
      payment_method,
      payment_status,
    },
  });

describe('cash registers', () => {
  let registerId: string;

  it('opens one register per location', async () => {
    const opened = await cashierA1('POST', '/cash-registers', { opening_amount_cop: 100000 });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ status: 'OPEN', opening_amount_cop: '100000', opened_by: orgA.users.CASHIER });
    registerId = opened.body.id;

    expect((await adminA1('POST', '/cash-registers', { opening_amount_cop: 0 })).status).toBe(409);
    expect((await adminA2('POST', '/cash-registers', { opening_amount_cop: 0 })).status).toBe(201);
  });

  it('serializes concurrent opens', async () => {
    const results = await Promise.all([1, 2, 3].map(() => ownerB('POST', '/cash-registers', { opening_amount_cop: 5000 })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('lists the location history newest first with the cashier name', async () => {
    const list = (await cashierA1('GET', '/cash-registers')).body;
    expect(list).toEqual([expect.objectContaining({ id: registerId, status: 'OPEN', users: { full_name: 'CASHIER' } })]);
  });

  it('closes with the cash count: expected counts only paid cash sales of this register', async () => {
    await order(registerId, 25000, 'CASH', 'PAID');
    await order(registerId, 10500.5, 'CASH', 'PAID');
    await order(registerId, 40000, 'FACTUS_PAY_QR', 'PAID');
    await order(registerId, 9000, 'CASH', 'UNPAID');

    const closed = await cashierA1('POST', `/cash-registers/${registerId}/close`, { actual_closing_cop: 135000 });
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ status: 'CLOSED', expected_closing_cop: '135500.5', actual_closing_cop: '135000' });
    expect(closed.body.closed_at).toEqual(expect.any(String));

    expect((await cashierA1('POST', `/cash-registers/${registerId}/close`, { actual_closing_cop: 1 })).status).toBe(409);
    expect((await cashierA1('POST', '/cash-registers', { opening_amount_cop: 0 })).status).toBe(201);
  });

  it("lists today's openings and closings of the location with who did each", async () => {
    const today = (await cashierA1('GET', '/cash-registers/today')).body;
    expect(today.map((e: { kind: string }) => e.kind)).toEqual(['REGISTER_OPEN', 'REGISTER_CLOSE', 'REGISTER_OPEN']);
    expect(today[1]).toMatchObject({ details: { register_id: registerId, actual_cop: '135000' }, users: { full_name: 'CASHIER' } });
    // Location 2 only sees its own opening.
    expect((await adminA2('GET', '/cash-registers/today')).body).toEqual([expect.objectContaining({ kind: 'REGISTER_OPEN' })]);
    expect((await waiterA1('GET', '/cash-registers/today')).status).toBe(403);
  });

  it('hides registers of other locations and organizations', async () => {
    const [open] = (await cashierA1('GET', '/cash-registers')).body;
    expect((await adminA2('POST', `/cash-registers/${open.id}/close`, { actual_closing_cop: 0 })).status).toBe(404);
    expect((await ownerB('POST', `/cash-registers/${open.id}/close`, { actual_closing_cop: 0 })).status).toBe(404);
    expect((await ownerB('GET', '/cash-registers')).body.every((r: { id: string }) => r.id !== open.id)).toBe(true);
  });

  it('rejects other roles, missing location and invalid amounts', async () => {
    expect((await waiterA1('GET', '/cash-registers')).status).toBe(403);
    expect((await client(app, orgA.users.ADMIN).then((c) => c('GET', '/cash-registers'))).status).toBe(400);
    expect((await adminA2('POST', '/cash-registers', {})).status).toBe(400);
    expect((await adminA2('POST', '/cash-registers', { opening_amount_cop: -1 })).status).toBe(400);
    expect((await adminA2('POST', `/cash-registers/${orgA.id}/close`, { actual_closing_cop: '10' })).status).toBe(400);
  });
});

describe('floors and dining tables', () => {
  let floor1: string; // floor of location 1
  let floor2: string; // floor of location 2
  let tableId: string;

  it('creates floors per location with unique names, listed in sort order', async () => {
    floor1 = (await adminA1('POST', '/floors', { name: 'Segundo piso', sort_order: 2 })).body.id;
    expect((await adminA1('POST', '/floors', { name: 'Terraza', sort_order: 1 })).status).toBe(201);
    expect((await adminA1('POST', '/floors', { name: 'Terraza' })).status).toBe(409);
    floor2 = (await adminA2('POST', '/floors', { name: 'Terraza' })).body.id;

    expect((await waiterA1('GET', '/floors')).body.map((f: { name: string }) => f.name)).toEqual(['Terraza', 'Segundo piso']);
    expect((await ownerB('GET', '/floors')).body).toEqual([]);
  });

  it('numbers tables per location and names them "Mesa #n" by default', async () => {
    const first = await adminA1('POST', '/tables', {});
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ number: 1, name: 'Mesa #1', capacity: 4, status: 'FREE', floor_id: null });
    tableId = first.body.id;

    expect((await adminA1('POST', '/tables', { floor_id: floor1 })).body).toMatchObject({ number: 2, name: 'Mesa #2' });
    expect((await adminA1('POST', '/tables', { number: 10, name: ' Barra ', capacity: 2 })).body).toMatchObject({ name: 'Barra' });
    expect((await adminA1('POST', '/tables', {})).body).toMatchObject({ number: 11, name: 'Mesa #11' });

    const names = (await waiterA1('GET', '/tables')).body.map((t: { name: string }) => t.name);
    expect(names).toEqual(['Mesa #1', 'Mesa #2', 'Barra', 'Mesa #11']);
    expect((await adminA2('GET', '/tables')).body).toEqual([]);
  });

  it('keeps numbers and names unique per location, also under concurrency', async () => {
    expect((await adminA1('POST', '/tables', { name: 'Barra' })).status).toBe(409);
    expect((await adminA1('POST', '/tables', { number: 2 })).status).toBe(409);
    const created = await Promise.all([1, 2, 3].map(() => adminA2('POST', '/tables', {})));
    expect(created.map((r) => r.body.number).sort()).toEqual([1, 2, 3]);
  });

  it('only accepts floors of the same location', async () => {
    expect((await adminA1('POST', '/tables', { floor_id: floor2 })).status).toBe(400);
    expect((await adminA1('PATCH', `/tables/${tableId}`, { floor_id: floor1 })).body).toMatchObject({ floor_id: floor1 });
    expect((await adminA1('PATCH', `/tables/${tableId}`, { floor_id: null })).body).toMatchObject({ floor_id: null });
  });

  it('creates a batch of tables on a floor, numbered after the last one, all or none', async () => {
    type Table = { number: number; name: string; floor_id: string | null; capacity: number };
    const patio = (await adminA1('POST', '/floors', { name: 'Patio' })).body.id;
    const res = await adminA1('POST', '/tables/batch', { count: 3, floor_id: patio, capacity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.map((t: Table) => [t.number, t.name, t.floor_id, t.capacity])).toEqual([
      [12, 'Mesa #12', patio, 2],
      [13, 'Mesa #13', patio, 2],
      [14, 'Mesa #14', patio, 2],
    ]);

    // 101..103 would be next, but the name "Mesa #102" is taken: nothing is created.
    await adminA1('POST', '/tables', { number: 100, name: 'Mesa #102' });
    expect((await adminA1('POST', '/tables/batch', { count: 3 })).status).toBe(409);
    expect((await adminA1('GET', '/tables')).body.some((t: Table) => t.number === 101)).toBe(false);

    expect((await adminA1('POST', '/tables/batch', {})).status).toBe(400);
    expect((await adminA1('POST', '/tables/batch', { count: 51 })).status).toBe(400);
    expect((await adminA1('POST', '/tables/batch', { count: 1, floor_id: floor2 })).status).toBe(400);
    expect((await waiterA1('POST', '/tables/batch', { count: 1 })).status).toBe(403);
  });

  it('lets floor staff change the status, only owner/admin edit tables and floors', async () => {
    const res = await waiterA1('PUT', `/tables/${tableId}/status`, { status: 'RESERVED' });
    expect(res.body).toMatchObject({ status: 'RESERVED' });
    expect((await waiterA1('PUT', `/tables/${tableId}/status`, { status: 'DIRTY' })).status).toBe(400);
    expect((await waiterA1('POST', '/tables', {})).status).toBe(403);
    expect((await waiterA1('POST', '/floors', { name: 'x' })).status).toBe(403);
    expect((await cashierA1('PATCH', `/tables/${tableId}`, { name: 'x' })).status).toBe(403);
    expect((await cashierA1('DELETE', `/floors/${floor1}`)).status).toBe(403);

    const renamed = await adminA1('PATCH', `/tables/${tableId}`, { name: 'Ventana', capacity: 6 });
    expect(renamed.body).toMatchObject({ name: 'Ventana', number: 1, capacity: 6, status: 'RESERVED' });
    expect((await adminA1('PATCH', `/floors/${floor1}`, { name: 'Piso 2' })).body).toMatchObject({ name: 'Piso 2' });
  });

  it('renames a default-named table when its number changes, keeps custom names', async () => {
    const tables: { id: string; number: number }[] = (await adminA1('GET', '/tables')).body;
    const second = tables.find((t) => t.number === 2)!.id;
    expect((await adminA1('PATCH', `/tables/${second}`, { number: 30 })).body).toMatchObject({ number: 30, name: 'Mesa #30' });
    expect((await adminA1('PATCH', `/tables/${tableId}`, { number: 31 })).body).toMatchObject({ number: 31, name: 'Ventana' });
    const both = await adminA1('PATCH', `/tables/${second}`, { number: 32, name: 'Rincón' });
    expect(both.body).toMatchObject({ number: 32, name: 'Rincón' });
    expect((await adminA2('PATCH', `/tables/${second}`, { number: 33 })).status).toBe(404);
  });

  it('validates the body', async () => {
    expect((await adminA1('POST', '/tables', { name: 'x'.repeat(41) })).status).toBe(400);
    expect((await adminA1('POST', '/tables', { number: 0 })).status).toBe(400);
    expect((await adminA1('POST', '/tables', { floor_id: 'piso' })).status).toBe(400);
    expect((await adminA1('PATCH', `/tables/${tableId}`, { capacity: 0 })).status).toBe(400);
    expect((await adminA1('POST', '/floors', {})).status).toBe(400);
    expect((await adminA1('POST', '/floors', { name: 'x', sort_order: -1 })).status).toBe(400);
  });

  it('hides tables and floors of other locations and organizations', async () => {
    expect((await adminA2('PATCH', `/tables/${tableId}`, { name: 'x' })).status).toBe(404);
    expect((await adminA2('PUT', `/tables/${tableId}/status`, { status: 'FREE' })).status).toBe(404);
    expect((await adminA2('DELETE', `/tables/${tableId}`)).status).toBe(404);
    expect((await ownerB('PATCH', `/tables/${tableId}`, { name: 'x' })).status).toBe(404);
    expect((await adminA2('PATCH', `/floors/${floor1}`, { name: 'x' })).status).toBe(404);
    expect((await ownerB('DELETE', `/floors/${floor1}`)).status).toBe(404);
  });

  it('refuses to delete a table with orders or a floor with tables (409)', async () => {
    const sale = await db.orders.create({
      data: {
        organization_id: orgA.id,
        location_id: orgA.locations[0],
        table_id: tableId,
        channel: 'POS',
        order_type: 'DINE_IN',
        subtotal_cop: 1000,
        tax_cop: 0,
        total_cop: 1000,
      },
    });
    expect((await adminA1('DELETE', `/tables/${tableId}`)).status).toBe(409);
    await db.orders.delete({ where: { id: sale.id } });
    expect((await adminA1('DELETE', `/tables/${tableId}`)).status).toBe(204);
    expect((await adminA1('DELETE', `/tables/${tableId}`)).status).toBe(404);

    expect((await adminA1('DELETE', `/floors/${floor1}`)).status).toBe(409);
    await db.dining_tables.deleteMany({ where: { floor_id: floor1 } });
    expect((await adminA1('DELETE', `/floors/${floor1}`)).status).toBe(204);
  });
});
