// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg; // SINGLE
let cashier1: Call; // location 1
let waiter1: Call;
let admin2: Call; // location 2
let ownerB: Call;
let latte: string;
let water: string;
let coffee: string; // ingredient
let milk: string; // ingredient
let table: string;

const modifiers = [
  { name: 'Tamaño', required: true, multiple: false, options: [{ name: 'Grande', price_cop: 2000 }, { name: 'Pequeño', price_cop: 0 }] },
  { name: 'Extras', required: false, multiple: true, options: [{ name: 'Shot', price_cop: 1500 }, { name: 'Crema', price_cop: 1000 }] },
];
const bigLatte = { product_id: '', quantity: 2, modifiers: [{ group: 'Tamaño', option: 'Grande' }, { group: 'Extras', option: 'Shot' }] };

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  const [loc1, loc2] = orgA.locations;
  const org = { organization_id: orgA.id };
  latte = (await db.products.create({ data: { ...org, name: 'Latte', base_price_cop: 8000, tax_rate: 8, modifiers_schema: modifiers } })).id;
  water = (await db.products.create({ data: { ...org, name: 'Agua', base_price_cop: 3000, tax_rate: 19 } })).id;
  bigLatte.product_id = latte;
  coffee = (await db.ingredients.create({ data: { ...org, name: 'Café', unit: 'gr' } })).id;
  milk = (await db.ingredients.create({ data: { ...org, name: 'Leche', unit: 'ml' } })).id;
  await db.product_recipes.createMany({
    data: [
      { ...org, product_id: latte, ingredient_id: coffee, quantity_required: 18 },
      { ...org, product_id: latte, ingredient_id: milk, quantity_required: 200 },
    ],
  });
  await db.location_stock.create({ data: { ...org, location_id: loc1, ingredient_id: coffee, current_qty: 1000, min_alert_qty: 950 } });
  await db.location_products.createMany({
    data: [
      { ...org, location_id: loc2, product_id: latte, custom_price_cop: 9000 },
      { ...org, location_id: loc2, product_id: water, is_available: false },
    ],
  });
  table = (await db.dining_tables.create({ data: { ...org, location_id: loc1, name: 'Mesa #1', number: 1 } })).id;
  const waiter = await db.users.create({
    data: { ...org, email: `waiter-${orgA.id}@test.demo`, password_hash: 'x', full_name: 'Mesero', role: 'WAITER' },
  });
  cashier1 = await client(app, orgA.users.CASHIER, loc1);
  waiter1 = await client(app, waiter.id, loc1);
  admin2 = await client(app, orgA.users.ADMIN, loc2);
  ownerB = await client(app, orgB.users.OWNER);
});

afterAll(async () => {
  // Orders with sold products go with the organization (migration 0007).
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('pricing', () => {
  it('prices items with modifiers and extracts the included tax', async () => {
    const res = await cashier1('POST', '/orders', {
      order_type: 'PICKUP',
      items: [bigLatte, { product_id: water, quantity: 1, notes: 'Sin hielo' }],
    });
    expect(res.status).toBe(201);
    // 2 x (8000 + 2000 + 1500) at 8% + 3000 at 19%: tax 1703.70 + 478.99.
    expect(res.body).toMatchObject({
      channel: 'POS',
      order_type: 'PICKUP',
      status: 'CONFIRMED',
      payment_status: 'UNPAID',
      total_cop: '26000',
      tax_cop: '2182.69',
      subtotal_cop: '23817.31',
    });
    expect(res.body.order_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: latte,
          round: 1,
          unit_price_cop: '11500',
          tax_rate: '8',
          products: { name: 'Latte' },
          selected_modifiers: [
            { group: 'Tamaño', option: 'Grande', price_cop: 2000 },
            { group: 'Extras', option: 'Shot', price_cop: 1500 },
          ],
        }),
        expect.objectContaining({ product_id: water, notes: 'Sin hielo', tax_rate: '19' }),
      ]),
    );
  });

  it('uses the location price and availability', async () => {
    const small = { product_id: latte, quantity: 1, modifiers: [{ group: 'Tamaño', option: 'Pequeño' }] };
    expect((await admin2('POST', '/orders', { order_type: 'PICKUP', items: [small] })).body.total_cop).toBe('9000');
    const res = await admin2('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('rejects invalid modifiers, products and bodies', async () => {
    const order = (items: unknown) => cashier1('POST', '/orders', { order_type: 'PICKUP', items });
    const pick = (...m: [string, string][]) => [{ product_id: latte, quantity: 1, modifiers: m.map(([group, option]) => ({ group, option })) }];
    expect((await order(pick())).status).toBe(400); // required size missing
    expect((await order(pick(['Tamaño', 'Grande'], ['Tamaño', 'Pequeño']))).status).toBe(400); // single choice
    expect((await order(pick(['Tamaño', 'Grande'], ['Extras', 'Shot'], ['Extras', 'Shot']))).status).toBe(400); // repeated
    expect((await order(pick(['Tamaño', 'Mediano']))).status).toBe(400); // unknown option
    const inactive = await db.products.create({ data: { organization_id: orgA.id, name: 'Viejo', base_price_cop: 1, is_active: false } });
    expect((await order([{ product_id: inactive.id, quantity: 1 }])).status).toBe(400);
    const foreign = await db.products.create({ data: { organization_id: orgB.id, name: 'Ajeno', base_price_cop: 1 } });
    expect((await order([{ product_id: foreign.id, quantity: 1 }])).status).toBe(400);
    expect((await order([])).status).toBe(400);
    expect((await order([{ product_id: water, quantity: 0 }])).status).toBe(400);
    expect((await cashier1('POST', '/orders', { order_type: 'DELIVERY', items: [{ product_id: water, quantity: 1 }] })).status).toBe(400);
  });
});

describe('table accounts', () => {
  let orderId: string;

  it('opens one account per table and marks it occupied', async () => {
    const water1 = [{ product_id: water, quantity: 1 }];
    expect((await waiter1('POST', '/orders', { order_type: 'DINE_IN', items: water1 })).status).toBe(400); // no table
    expect((await waiter1('POST', '/orders', { order_type: 'PICKUP', table_id: table, items: water1 })).status).toBe(400);
    expect((await admin2('POST', '/orders', { order_type: 'DINE_IN', table_id: table, items: water1 })).status).toBe(400); // other location

    const opened = await Promise.all([1, 2].map(() => waiter1('POST', '/orders', { order_type: 'DINE_IN', table_id: table, items: [bigLatte] })));
    expect(opened.map((r) => r.status).sort()).toEqual([201, 409]);
    orderId = opened.find((r) => r.status === 201)!.body.id;
    await expect(db.dining_tables.findUnique({ where: { id: table } })).resolves.toMatchObject({ status: 'OCCUPIED' });
  });

  it('adds rounds to the open account', async () => {
    const res = await waiter1('POST', `/orders/${orderId}/items`, { items: [{ product_id: water, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.total_cop).toBe('29000');
    expect(res.body.order_items.map((i: { round: number }) => i.round)).toEqual([1, 2]);

    const open = (await waiter1('GET', '/orders')).body.map((o: { id: string }) => o.id);
    expect(open).toContain(orderId);
    expect((await waiter1('GET', `/orders/${orderId}`)).body.dining_tables).toEqual({ name: 'Mesa #1' });
  });

  it('charges into the open register, deducts stock and frees the table', async () => {
    expect((await waiter1('POST', `/orders/${orderId}/pay`, { payment_method: 'CASH' })).status).toBe(403);
    expect((await cashier1('POST', `/orders/${orderId}/pay`, { payment_method: 'CASH' })).status).toBe(409); // no register
    expect((await cashier1('POST', `/orders/${orderId}/pay`, { payment_method: 'FACTUS_PAY_QR' })).status).toBe(400);
    const tip = (t: object) => cashier1('POST', `/orders/${orderId}/pay`, { payment_method: 'CASH', ...t });
    expect((await tip({ tip_percent: 7 })).status).toBe(400);
    expect((await tip({ tip_cop: -1 })).status).toBe(400);
    expect((await tip({ tip_percent: 5, tip_cop: 1000 })).status).toBe(400);

    const register = (await cashier1('POST', '/cash-registers', { opening_amount_cop: 50000 })).body.id;
    const paid = await tip({ tip_percent: 10 });
    expect(paid.status).toBe(201);
    // Total 29000, tax 1703.70 + 957.98, subtotal 26338.32: 10% tip rounded to whole pesos = 2634.
    expect(paid.body).toMatchObject({
      payment_status: 'PAID',
      payment_method: 'CASH',
      status: 'COMPLETED',
      cash_register_id: register,
      subtotal_cop: '26338.32',
      total_cop: '29000',
      tip_cop: '2634',
    });
    // 2 lattes: coffee 1000 - 36 = 964 (alert at 950 not reached); milk had no stock row: -400.
    expect(paid.body.stock_alerts).toEqual([
      { ingredient_id: milk, name: 'Leche', unit: 'ml', current_qty: '-400.000', min_alert_qty: '0.000' },
    ]);
    const loc1 = orgA.locations[0];
    const coffeeQty = (await db.location_stock.findUnique({ where: { location_id_ingredient_id: { location_id: loc1, ingredient_id: coffee } } }))!.current_qty;
    expect(coffeeQty.toString()).toBe('964');
    await expect(db.dining_tables.findUnique({ where: { id: table } })).resolves.toMatchObject({ status: 'FREE' });

    expect((await cashier1('POST', `/orders/${orderId}/pay`, { payment_method: 'CASH' })).status).toBe(409);
    expect((await waiter1('POST', `/orders/${orderId}/items`, { items: [{ product_id: water, quantity: 1 }] })).status).toBe(409);
    expect((await cashier1('POST', `/orders/${orderId}/cancel`)).status).toBe(409);
    expect((await waiter1('GET', '/orders')).body.map((o: { id: string }) => o.id)).not.toContain(orderId);

    // Cash count of 2.5: opening 50000 + this cash sale 29000 + its tip 2634.
    const closed = await cashier1('POST', `/cash-registers/${register}/close`, { actual_closing_cop: 81634 });
    expect(closed.body.expected_closing_cop).toBe('81634');
  });

  it('cancels an unpaid account without touching stock and frees the table', async () => {
    const { body } = await waiter1('POST', '/orders', { order_type: 'DINE_IN', table_id: table, items: [bigLatte] });
    expect((await waiter1('POST', `/orders/${body.id}/cancel`)).status).toBe(403);
    const cancelled = await cashier1('POST', `/orders/${body.id}/cancel`);
    expect(cancelled.body.status).toBe('CANCELLED');
    await expect(db.dining_tables.findUnique({ where: { id: table } })).resolves.toMatchObject({ status: 'FREE' });
    const coffeeQty = (await db.location_stock.findUnique({
      where: { location_id_ingredient_id: { location_id: orgA.locations[0], ingredient_id: coffee } },
    }))!.current_qty;
    expect(coffeeQty.toString()).toBe('964');
  });

  it('keeps a paid counter order in the kitchen flow', async () => {
    await cashier1('POST', '/cash-registers', { opening_amount_cop: 0 });
    const { body } = await cashier1('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 1 }] });
    const paid = await cashier1('POST', `/orders/${body.id}/pay`, { payment_method: 'MANUAL_TRANSFER', tip_cop: 1500 });
    expect(paid.body).toMatchObject({ payment_status: 'PAID', status: 'CONFIRMED', tip_cop: '1500', stock_alerts: [] });
  });

  it('voids a line of an open account, only for cashiers and above', async () => {
    const { body } = await waiter1('POST', '/orders', { order_type: 'PICKUP', items: [bigLatte, { product_id: water, quantity: 1 }] });
    const line = body.order_items.find((i: { product_id: string }) => i.product_id === water).id;
    expect((await waiter1('DELETE', `/orders/${body.id}/items/${line}`)).status).toBe(403);

    const voided = await cashier1('DELETE', `/orders/${body.id}/items/${line}`);
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ total_cop: '23000', tax_cop: '1703.7', subtotal_cop: '21296.3' });
    expect(voided.body.order_items).toHaveLength(1);
    expect((await cashier1('DELETE', `/orders/${body.id}/items/${line}`)).status).toBe(404);

    const other = (await waiter1('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 1 }] })).body;
    const otherLine = other.order_items[0].id;
    expect((await cashier1('DELETE', `/orders/${body.id}/items/${otherLine}`)).status).toBe(404);
    await cashier1('POST', `/orders/${other.id}/pay`, { payment_method: 'CASH' });
    expect((await cashier1('DELETE', `/orders/${other.id}/items/${otherLine}`)).status).toBe(409);
  });

  it('hides orders of other locations and organizations', async () => {
    const { body } = await waiter1('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 1 }] });
    expect((await admin2('GET', `/orders/${body.id}`)).status).toBe(404);
    expect((await admin2('POST', `/orders/${body.id}/pay`, { payment_method: 'CASH' })).status).toBe(404);
    expect((await ownerB('GET', `/orders/${body.id}`)).status).toBe(404);
    expect((await ownerB('POST', `/orders/${body.id}/cancel`)).status).toBe(404);
    expect((await ownerB('GET', '/orders')).body).toEqual([]);
  });
});
