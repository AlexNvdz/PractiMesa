// Integration test: real app over HTTP + Postgres (order_rounds, RLS, migration 0011 trigger).
import type { INestApplication } from '@nestjs/common';
import { LiveEvent, LiveEventsService } from '../live/live-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg; // SINGLE
let cashier1: Call;
let waiter1: Call;
let kitchen1: Call;
let kitchen2: Call; // location 2
let ownerB: Call;
let soup: string;
let table: string;

const line = (product_id: string, extra = {}) => ({ items: [{ product_id, quantity: 1, ...extra }] });
const ids = (rounds: { id: string }[]) => rounds.map((r) => r.id);
const kitchenRounds = async (call: Call) => (await call('GET', '/kitchen/rounds')).body as { id: string; status: string }[];

async function user(role: 'WAITER' | 'KITCHEN') {
  const created = await db.users.create({
    data: { organization_id: orgA.id, email: `${role.toLowerCase()}-${orgA.id}@test.demo`, password_hash: 'x', full_name: role, role },
  });
  return created.id;
}

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  const [loc1, loc2] = orgA.locations;
  soup = (await db.products.create({ data: { organization_id: orgA.id, name: 'Ajiaco', base_price_cop: 25000 } })).id;
  table = (await db.dining_tables.create({ data: { organization_id: orgA.id, location_id: loc1, name: 'Mesa #1', number: 1 } })).id;
  cashier1 = await client(app, orgA.users.CASHIER, loc1);
  waiter1 = await client(app, await user('WAITER'), loc1);
  const cook = await user('KITCHEN');
  kitchen1 = await client(app, cook, loc1);
  kitchen2 = await client(app, cook, loc2);
  ownerB = await client(app, orgB.users.OWNER);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('kitchen rounds', () => {
  let order: { id: string; order_rounds: { id: string; round: number; status: string }[] };

  it('opens a ticket per round, oldest first, only for its location', async () => {
    order = (await waiter1('POST', '/orders', { order_type: 'DINE_IN', table_id: table, ...line(soup, { notes: 'Sin cebolla' }) })).body;
    order = (await waiter1('POST', `/orders/${order.id}/items`, line(soup))).body;
    expect(order.order_rounds).toEqual([
      { id: expect.any(String), round: 1, status: 'PENDING' },
      { id: expect.any(String), round: 2, status: 'PENDING' },
    ]);
    const admin2 = await client(app, orgA.users.ADMIN, orgA.locations[1]);
    expect((await admin2('POST', '/orders', { order_type: 'PICKUP', ...line(soup) })).status).toBe(201);
    const soupB = (await db.products.create({ data: { organization_id: orgB.id, name: 'Ajiaco', base_price_cop: 25000 } })).id;
    expect((await ownerB('POST', '/orders', { order_type: 'PICKUP', ...line(soupB) })).status).toBe(201);

    const { status, body } = await kitchen1('GET', '/kitchen/rounds');
    expect(status).toBe(200);
    expect(ids(body)).toEqual(ids(order.order_rounds));
    expect(body[0]).toMatchObject({
      order_id: order.id,
      round: 1,
      status: 'PENDING',
      orders: { order_type: 'DINE_IN', dining_tables: { name: 'Mesa #1' } },
      order_items: [{ quantity: 1, notes: 'Sin cebolla', selected_modifiers: [], products: { name: 'Ajiaco' } }],
    });
    expect(await kitchenRounds(kitchen2)).toHaveLength(1);
    expect(await kitchenRounds(ownerB)).toHaveLength(1);
  });

  it('moves a round forward only, and only the kitchen moves it before delivery', async () => {
    const [first] = order.order_rounds;
    const put = (call: Call, status: string) => call('PUT', `/kitchen/rounds/${first.id}`, { status });

    const started = await put(kitchen1, 'PREPARING');
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'PREPARING', started_at: expect.any(String), ready_at: null });
    expect((await put(waiter1, 'READY')).status).toBe(403);
    expect((await put(kitchen1, 'READY')).body).toMatchObject({ status: 'READY', ready_at: expect.any(String) });
    // A double tap repeats the step; a stale screen cannot move it back.
    expect((await put(kitchen1, 'READY')).status).toBe(200);
    const back = await put(kitchen1, 'PREPARING');
    expect(back.status).toBe(409);
    expect(back.body.message).toBe('La comanda ya está lista');

    expect((await put(waiter1, 'DELIVERED')).body).toMatchObject({ status: 'DELIVERED', delivered_at: expect.any(String) });
    expect(ids(await kitchenRounds(kitchen1))).toEqual([order.order_rounds[1].id]);
    // The POS sees the state of each round in the account.
    const account = (await cashier1('GET', `/orders/${order.id}`)).body;
    expect(account.order_rounds.map((r: { status: string }) => r.status)).toEqual(['DELIVERED', 'PENDING']);
  });

  it('rejects bad steps and rounds of another location or organization', async () => {
    const second = order.order_rounds[1].id;
    expect((await kitchen1('PUT', `/kitchen/rounds/${second}`, { status: 'PENDING' })).status).toBe(400);
    expect((await kitchen1('PUT', `/kitchen/rounds/${second}`, {})).status).toBe(400);
    expect((await kitchen2('PUT', `/kitchen/rounds/${second}`, { status: 'READY' })).status).toBe(404);
    expect((await ownerB('PUT', `/kitchen/rounds/${second}`, { status: 'READY' })).status).toBe(404);
    expect((await kitchen1('PUT', '/kitchen/rounds/not-a-uuid', { status: 'READY' })).status).toBe(400);
  });

  it('keeps paid counter orders, drops cancelled ones and rounds with every line voided', async () => {
    await cashier1('POST', '/cash-registers', { opening_amount_cop: 0 });
    const paid = (await cashier1('POST', '/orders', { order_type: 'PICKUP', ...line(soup) })).body;
    expect((await cashier1('POST', `/orders/${paid.id}/pay`, { payment_method: 'CASH' })).status).toBe(201);
    const cancelled = (await cashier1('POST', '/orders', { order_type: 'PICKUP', ...line(soup) })).body;
    await cashier1('POST', `/orders/${cancelled.id}/cancel`);
    const voided = (await cashier1('POST', `/orders/${order.id}/items`, line(soup))).body;
    const third = voided.order_items.find((i: { round: number }) => i.round === 3);
    await cashier1('DELETE', `/orders/${order.id}/items/${third.id}`);

    expect(ids(await kitchenRounds(kitchen1))).toEqual([order.order_rounds[1].id, paid.order_rounds[0].id]);
    const late = await kitchen1('PUT', `/kitchen/rounds/${cancelled.order_rounds[0].id}`, { status: 'READY' });
    expect(late.status).toBe(409);
    expect(late.body.message).toBe('El pedido fue anulado');
    // The next round keeps counting after the emptied one.
    const next = (await waiter1('POST', `/orders/${order.id}/items`, line(soup))).body;
    expect(next.order_rounds.map((r: { round: number }) => r.round)).toEqual([1, 2, 3, 4]);
  });

  it('undoes a step only from the step the screen saw', async () => {
    const pickup = (await cashier1('POST', '/orders', { order_type: 'PICKUP', ...line(soup) })).body;
    const url = `/kitchen/rounds/${pickup.order_rounds[0].id}`;
    expect((await kitchen1('PUT', url, { status: 'PENDING' })).status).toBe(400);
    await kitchen1('PUT', url, { status: 'READY' });

    const undone = await kitchen1('PUT', url, { status: 'PREPARING', from: 'READY' });
    expect(undone.status).toBe(200);
    // Back to "in preparation": it was ready by mistake, so it never was ready.
    expect(undone.body).toMatchObject({ status: 'PREPARING', ready_at: null });
    expect((await kitchen1('PUT', url, { status: 'PREPARING', from: 'READY' })).status).toBe(200); // double tap
    const stale = await kitchen1('PUT', url, { status: 'PENDING', from: 'READY' });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe('La comanda ya está en preparación');

    // Who serves undoes a delivery, and nothing else.
    await kitchen1('PUT', url, { status: 'READY' });
    expect((await waiter1('PUT', url, { status: 'PREPARING', from: 'READY' })).status).toBe(403);
    await waiter1('PUT', url, { status: 'DELIVERED' });
    expect(ids(await kitchenRounds(kitchen1))).not.toContain(pickup.order_rounds[0].id);
    const back = await waiter1('PUT', url, { status: 'READY', from: 'DELIVERED' });
    expect(back.body).toMatchObject({ status: 'READY', ready_at: expect.any(String), delivered_at: null });
    expect(ids(await kitchenRounds(kitchen1))).toContain(pickup.order_rounds[0].id);
  });

  it('announces a round change as an event of its order', async () => {
    const seen: LiveEvent[] = [];
    const unsubscribe = app.get(LiveEventsService).subscribe((e) => e && seen.push(e));
    const round = order.order_rounds[1].id;
    await kitchen1('PUT', `/kitchen/rounds/${round}`, { status: 'PREPARING' });
    const deadline = Date.now() + 5000;
    while (!seen.some((e) => e.id === order.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    unsubscribe();
    expect(seen).toContainEqual({ type: 'order', id: order.id, organization_id: orgA.id, location_id: orgA.locations[0] });
  });
});
