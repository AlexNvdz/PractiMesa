// Integration test: the paged inventory and catalog screens, real app over HTTP + Postgres.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let org: TestOrg; // MULTI, 2 locations
let other: TestOrg;
let cashier: Call; // location 0
let cashierSouth: Call; // location 1
let kitchen: Call;
let otherOwner: Call;

beforeAll(async () => {
  app = await startApp();
  org = await createOrg(db, 'MULTI', 2);
  other = await createOrg(db, 'SINGLE', 1);
  cashier = await client(app, org.users.CASHIER, org.locations[0]);
  cashierSouth = await client(app, org.users.CASHIER, org.locations[1]);
  const cook = await db.users.create({
    data: { organization_id: org.id, email: `kitchen-${org.id.slice(0, 8)}@test.demo`, password_hash: 'x', full_name: 'Cocina', role: 'KITCHEN' },
  });
  kitchen = await client(app, cook.id, org.locations[0]);
  otherOwner = await client(app, other.users.OWNER, other.locations[0]);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  await db.$disconnect();
  await app.close();
});

const names = (body: { items: { name: string }[] }) => body.items.map((i) => i.name);

describe('GET /inventory', () => {
  beforeAll(async () => {
    const make = (name: string) => db.ingredients.create({ data: { organization_id: org.id, name, unit: 'gr' } });
    const [milk, coffee, sugar, , flour, odd] = await Promise.all(['Leche', 'Café', 'Azúcar', 'Sal', 'Harina', 'Té_frío'].map(make));
    const stock = (ingredient_id: string, location_id: string, current_qty: number, min_alert_qty: number) =>
      db.location_stock.create({ data: { organization_id: org.id, ingredient_id, location_id, current_qty, min_alert_qty } });
    await db.ingredients.update({ where: { id: milk.id }, data: { category: 'Lácteos y huevos' } });
    await stock(milk.id, org.locations[0], 5, 10); // under its minimum
    await stock(coffee.id, org.locations[0], 0, 3); // nothing left
    await stock(sugar.id, org.locations[0], 100, 10); // fine
    await stock(odd.id, org.locations[0], -2, 0); // sold past zero
    // Harina is only in a recipe of a product that location 0 does not sell.
    const product = await db.products.create({ data: { organization_id: org.id, name: 'Torta', base_price_cop: 1000 } });
    await db.product_recipes.create({ data: { organization_id: org.id, product_id: product.id, ingredient_id: flour.id, quantity_required: 1 } });
    await db.location_products.create({ data: { organization_id: org.id, location_id: org.locations[0], product_id: product.id, is_listed: false } });
  });

  // The recipe product only served this suite; the catalog suite below counts products.
  afterAll(() => db.products.deleteMany({ where: { organization_id: org.id, name: 'Torta' } }));

  it('lists what the location works with, with its stock and the counts of every tab', async () => {
    const { status, body } = await cashier('GET', '/inventory');
    expect(status).toBe(200);
    // Harina is hidden here; Sal has no stock row and no recipe, so it shows with nothing in stock.
    expect(names(body)).toEqual(['Azúcar', 'Café', 'Leche', 'Sal', 'Té_frío']);
    expect(body).toMatchObject({ total: 5, next: null, counts: { all: 5, alert: 4, out: 3 } });
    expect(body.items.find((i: { name: string }) => i.name === 'Leche')).toMatchObject({ current_qty: '5', min_alert_qty: '10', unit: 'gr' });
    expect(body.items.find((i: { name: string }) => i.name === 'Sal')).toMatchObject({ current_qty: '0', min_alert_qty: '0' });
    // The other location sees Harina (its product is sold there) and none of this stock.
    const south = (await cashierSouth('GET', '/inventory')).body;
    expect(names(south)).toContain('Harina');
    expect(south.items.find((i: { name: string }) => i.name === 'Leche')).toMatchObject({ current_qty: '0' });
  });

  it('filters by alert and out, keeping the counts of the whole list', async () => {
    const alert = (await cashier('GET', '/inventory?filter=alert')).body;
    expect(names(alert)).toEqual(['Café', 'Leche', 'Sal', 'Té_frío']);
    expect(alert).toMatchObject({ total: 4, counts: { all: 5, alert: 4, out: 3 } });
    const out = (await cashier('GET', '/inventory?filter=out')).body;
    expect(names(out)).toEqual(['Café', 'Sal', 'Té_frío']);
  });

  it('searches ignoring case and accents, and takes % and _ literally', async () => {
    expect(names((await cashier('GET', '/inventory?q=CAFE')).body)).toEqual(['Café']);
    // The group is searchable too, and comes with each row.
    const byGroup = (await cashier('GET', '/inventory?q=LACTEOS')).body;
    expect(byGroup.items).toMatchObject([{ name: 'Leche', category: 'Lácteos y huevos' }]);
    expect(names((await cashier('GET', '/inventory?q=azucar')).body)).toEqual(['Azúcar']);
    expect(names((await cashier('GET', '/inventory?q=_')).body)).toEqual(['Té_frío']);
    expect(names((await cashier('GET', '/inventory?q=%25')).body)).toEqual([]);
    expect((await cashier('GET', '/inventory?q=zzz')).body).toMatchObject({ items: [], total: 0, next: null });
  });

  it('pages with limit and offset', async () => {
    const first = (await cashier('GET', '/inventory?limit=2')).body;
    expect(names(first)).toEqual(['Azúcar', 'Café']);
    expect(first).toMatchObject({ total: 5, next: 2 });
    const last = (await cashier('GET', '/inventory?limit=2&offset=4')).body;
    expect(names(last)).toEqual(['Té_frío']);
    expect(last.next).toBeNull();
    // Past the end: no rows, but the total is still right.
    expect((await cashier('GET', '/inventory?limit=2&offset=40')).body).toMatchObject({ items: [], total: 5, next: null });
  });

  it('rejects bad parameters and roles without inventory', async () => {
    expect((await cashier('GET', '/inventory?filter=weird')).status).toBe(400);
    expect((await cashier('GET', '/inventory?limit=abc')).status).toBe(400);
    expect((await cashier('GET', '/inventory?offset=-1')).status).toBe(400);
    expect((await kitchen('GET', '/inventory')).status).toBe(403);
  });

  it('never shows another organization', async () => {
    expect((await otherOwner('GET', '/inventory')).body).toMatchObject({ items: [], total: 0, counts: { all: 0 } });
  });
});

describe('GET /products/page', () => {
  let drinks: string;
  let food: string;

  beforeAll(async () => {
    drinks = (await db.categories.create({ data: { organization_id: org.id, name: 'Bebidas', sort_order: 1 } })).id;
    food = (await db.categories.create({ data: { organization_id: org.id, name: 'Comida', sort_order: 2 } })).id;
    const make = (name: string, category_id: string | null, location_id: string | null = null) =>
      db.products.create({ data: { organization_id: org.id, name, category_id, location_id, base_price_cop: 5000 } });
    const coffee = await make('Café', drinks);
    await make('Té', drinks);
    await make('Arepa', food);
    await make('Extra', null);
    await make('Solo Sur', food, org.locations[1]);
    await db.location_products.create({
      data: { organization_id: org.id, location_id: org.locations[0], product_id: coffee.id, custom_price_cop: 6500, is_available: false },
    });
  });

  it('pages in category order with this location price, hides other locations own products and counts per category', async () => {
    const { status, body } = await cashier('GET', '/products/page');
    expect(status).toBe(200);
    expect(names(body)).toEqual(['Café', 'Té', 'Arepa', 'Extra']);
    expect(body).toMatchObject({ total: 4, next: null, counts: { all: 4, [drinks]: 2, [food]: 1, none: 1 } });
    expect(body.items[0].local).toMatchObject({ custom_price_cop: '6500', is_available: false });
    expect(body.items[1].local).toBeNull();
    // The south location also sees its own product, and its count.
    const south = (await cashierSouth('GET', '/products/page')).body;
    expect(names(south)).toEqual(['Café', 'Té', 'Arepa', 'Solo Sur', 'Extra']);
    expect(south.counts).toMatchObject({ all: 5, [food]: 2 });
  });

  it('filters by category and by name without accents, and pages', async () => {
    expect(names((await cashier('GET', `/products/page?category=${drinks}`)).body)).toEqual(['Café', 'Té']);
    expect(names((await cashier('GET', '/products/page?category=none')).body)).toEqual(['Extra']);
    expect(names((await cashier('GET', '/products/page?q=cafe')).body)).toEqual(['Café']);
    const first = (await cashier('GET', '/products/page?limit=3')).body;
    expect(names(first)).toEqual(['Café', 'Té', 'Arepa']);
    expect(first).toMatchObject({ total: 4, next: 3, counts: { all: 4 } });
    expect(names((await cashier('GET', '/products/page?limit=3&offset=3')).body)).toEqual(['Extra']);
    expect((await cashier('GET', '/products/page?limit=3&offset=30')).body).toMatchObject({ items: [], total: 4, next: null });
  });

  it('rejects a bad category and a missing location', async () => {
    expect((await cashier('GET', '/products/page?category=nope')).status).toBe(400);
    expect((await (await client(app, org.users.CASHIER))('GET', '/products/page')).status).toBe(400);
  });

  it('never shows another organization', async () => {
    expect((await otherOwner('GET', '/products/page')).body).toMatchObject({ items: [], total: 0, counts: { all: 0 } });
  });
});
