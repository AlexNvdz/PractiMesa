// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg; // SINGLE
let adminA: Call;
let cashierA: Call;
let ownerB: Call;

const modifiers = [
  { name: 'Tamaño', required: true, multiple: false, options: [{ name: 'Grande', price_cop: 2000 }, { name: 'Pequeño', price_cop: 0 }] },
];

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  adminA = await client(app, orgA.users.ADMIN);
  cashierA = await client(app, orgA.users.CASHIER);
  ownerB = await client(app, orgB.users.OWNER);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('categories', () => {
  it('creates, lists in sort order, updates and deletes', async () => {
    const drinks = await adminA('POST', '/categories', { name: 'Bebidas', sort_order: 2 });
    const food = await adminA('POST', '/categories', { name: 'Comidas', sort_order: 1 });
    expect([drinks.status, food.status]).toEqual([201, 201]);

    const list = await cashierA('GET', '/categories');
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Comidas', 'Bebidas']);

    const renamed = await adminA('PATCH', `/categories/${drinks.body.id}`, { name: 'Bebidas frías' });
    expect(renamed.body.name).toBe('Bebidas frías');

    const product = await db.products.create({
      data: { organization_id: orgA.id, category_id: food.body.id, name: 'Arepa', base_price_cop: 5000 },
    });
    expect((await adminA('DELETE', `/categories/${food.body.id}`)).status).toBe(204);
    expect((await adminA('DELETE', `/categories/${food.body.id}`)).status).toBe(404);
    // Products survive without category (composite FK sets only category_id to NULL).
    await expect(db.products.findUnique({ where: { id: product.id } })).resolves.toMatchObject({ category_id: null });
    await db.products.delete({ where: { id: product.id } });
  });

  it('lets only owner/admin write', async () => {
    expect((await cashierA('POST', '/categories', { name: 'x' })).status).toBe(403);
  });

  it('hides other organizations categories', async () => {
    const { body } = await adminA('POST', '/categories', { name: 'Privada' });
    expect((await ownerB('GET', '/categories')).body).toEqual([]);
    expect((await ownerB('PATCH', `/categories/${body.id}`, { name: 'x' })).status).toBe(404);
    expect((await ownerB('DELETE', `/categories/${body.id}`)).status).toBe(404);
  });

  it('validates the body', async () => {
    expect((await adminA('POST', '/categories', { name: '   ' })).status).toBe(400);
    expect((await adminA('POST', '/categories', { name: 'x', sort_order: 1.5 })).status).toBe(400);
    expect((await adminA('POST', '/categories', ['x'])).status).toBe(400);
  });
});

describe('products', () => {
  let productId: string;

  it('creates a product with modifiers', async () => {
    const res = await adminA('POST', '/products', {
      name: 'Café latte',
      base_price_cop: 8500,
      tax_rate: 8,
      image_url: '/menu/latte.jpg',
      modifiers_schema: modifiers,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Café latte', base_price_cop: '8500', modifiers_schema: modifiers, is_active: true });
    productId = res.body.id;
  });

  it.each([
    [{ name: 'x' }],
    [{ name: 'x', base_price_cop: -1 }],
    [{ name: 'x', base_price_cop: 1, image_url: 'javascript:alert(1)' }],
    [{ name: 'x', base_price_cop: 1, modifiers_schema: [{ ...modifiers[0], options: [] }] }],
    [{ name: 'x', base_price_cop: 1, modifiers_schema: [modifiers[0], modifiers[0]] }],
  ])('rejects invalid product %j', async (body) => {
    expect((await adminA('POST', '/products', body)).status).toBe(400);
  });

  it('rejects a category of another organization', async () => {
    const { body: categoryB } = await ownerB('POST', '/categories', { name: 'De B' });
    const res = await adminA('POST', '/products', { name: 'x', base_price_cop: 1, category_id: categoryB.id });
    expect(res.status).toBe(400);
  });

  it('lists and updates only own products', async () => {
    expect((await cashierA('GET', '/products')).body.map((p: { id: string }) => p.id)).toEqual([productId]);
    expect((await ownerB('GET', '/products')).body).toEqual([]);
    const res = await adminA('PATCH', `/products/${productId}`, { is_active: false, description: null });
    expect(res.body).toMatchObject({ is_active: false, description: null });
    expect((await ownerB('PATCH', `/products/${productId}`, { name: 'x' })).status).toBe(404);
  });

  it('refuses to delete a product already sold (409) and deletes an unsold one', async () => {
    const order = await db.orders.create({
      data: {
        organization_id: orgA.id,
        location_id: orgA.locations[0],
        channel: 'POS',
        order_type: 'PICKUP',
        subtotal_cop: 8500,
        tax_cop: 680,
        total_cop: 9180,
        order_rounds: { create: { round: 1 } },
      },
    });
    await db.order_items.create({ data: { organization_id: orgA.id, order_id: order.id, product_id: productId, quantity: 1, unit_price_cop: 8500 } });
    expect((await adminA('DELETE', `/products/${productId}`)).status).toBe(409);
    await db.orders.delete({ where: { id: order.id } });

    const { body: unsold } = await adminA('POST', '/products', { name: 'Temporal', base_price_cop: 1 });
    expect((await adminA('DELETE', `/products/${unsold.id}`)).status).toBe(204);
  });
});

describe('ingredients and recipes', () => {
  let productId: string;
  let milk: string;
  let coffee: string;

  beforeAll(async () => {
    productId = (await adminA('POST', '/products', { name: 'Capuchino', base_price_cop: 7000 })).body.id;
  });

  it('creates, lists, updates and deletes ingredients', async () => {
    milk = (await adminA('POST', '/ingredients', { name: 'Leche', unit: 'ml' })).body.id;
    coffee = (await adminA('POST', '/ingredients', { name: 'Café', unit: 'gr' })).body.id;
    const temp = (await adminA('POST', '/ingredients', { name: 'Temporal', unit: 'und' })).body.id;

    expect((await adminA('PATCH', `/ingredients/${coffee}`, { name: 'Café molido' })).body.name).toBe('Café molido');
    expect((await adminA('DELETE', `/ingredients/${temp}`)).status).toBe(204);
    expect((await cashierA('GET', '/ingredients')).body.map((i: { name: string }) => i.name)).toEqual(['Café molido', 'Leche']);
    expect((await adminA('POST', '/ingredients', { name: 'Azúcar' })).status).toBe(400);
    expect((await ownerB('GET', '/ingredients')).body).toEqual([]);
  });

  it('replaces the whole recipe', async () => {
    await adminA('PUT', `/products/${productId}/recipe`, [{ ingredient_id: milk, quantity_required: 100 }]);
    const res = await adminA('PUT', `/products/${productId}/recipe`, [
      { ingredient_id: milk, quantity_required: 150 },
      { ingredient_id: coffee, quantity_required: 18.5 },
    ]);
    expect(res.status).toBe(200);
    const recipe = (await cashierA('GET', `/products/${productId}/recipe`)).body;
    expect(recipe).toHaveLength(2);
    expect(recipe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ingredient_id: milk, quantity_required: '150', ingredients: { name: 'Leche', unit: 'ml' } }),
        expect.objectContaining({ ingredient_id: coffee, quantity_required: '18.5' }),
      ]),
    );
  });

  it('rejects invalid recipes', async () => {
    const path = `/products/${productId}/recipe`;
    expect((await adminA('PUT', path, { ingredient_id: milk })).status).toBe(400);
    expect((await adminA('PUT', path, [{ ingredient_id: milk, quantity_required: 0 }])).status).toBe(400);
    const duplicated = [milk, milk].map((id) => ({ ingredient_id: id, quantity_required: 1 }));
    expect((await adminA('PUT', path, duplicated)).status).toBe(409);
    // The failed replacement rolled back: the previous recipe is intact.
    expect((await adminA('GET', path)).body).toHaveLength(2);
  });

  it('isolates recipes between organizations', async () => {
    const { body: ingredientB } = await ownerB('POST', '/ingredients', { name: 'Leche B', unit: 'ml' });
    const res = await adminA('PUT', `/products/${productId}/recipe`, [{ ingredient_id: ingredientB.id, quantity_required: 1 }]);
    expect(res.status).toBe(400);
    expect((await ownerB('PUT', `/products/${productId}/recipe`, [])).status).toBe(404);
    expect((await ownerB('GET', `/products/${productId}/recipe`)).body).toEqual([]);
  });
});

describe('per-location prices, availability and stock', () => {
  let productId: string;
  let ingredientId: string;

  beforeAll(async () => {
    productId = (await adminA('POST', '/products', { name: 'Brownie', base_price_cop: 6000 })).body.id;
    ingredientId = (await adminA('POST', '/ingredients', { name: 'Harina', unit: 'gr' })).body.id;
  });

  it('sets price and availability for the request location only', async () => {
    const loc1 = await client(app, orgA.users.ADMIN, orgA.locations[0]);
    const loc2 = await client(app, orgA.users.ADMIN, orgA.locations[1]);

    expect((await loc1('PUT', `/location-products/${productId}`, { custom_price_cop: 6500 })).status).toBe(200);
    const res = await loc1('PUT', `/location-products/${productId}`, { is_available: false });
    expect(res.body).toMatchObject({ location_id: orgA.locations[0], custom_price_cop: '6500', is_available: false });

    expect((await loc1('GET', '/location-products')).body).toHaveLength(1);
    expect((await loc2('GET', '/location-products')).body).toEqual([]);
  });

  it('requires a location on MULTI and rejects locations of another organization', async () => {
    expect((await adminA('GET', '/location-products')).status).toBe(400);
    const foreign = await client(app, orgA.users.ADMIN, orgB.locations[0]);
    expect((await foreign('GET', '/location-stock')).status).toBe(403);
  });

  it('resolves the only location on SINGLE and rejects another organization product', async () => {
    const res = await ownerB('PUT', `/location-products/${productId}`, { custom_price_cop: 1 });
    expect(res.status).toBe(400);
  });

  it('lets only owner/admin write overrides', async () => {
    const cashier = await client(app, orgA.users.CASHIER, orgA.locations[0]);
    expect((await cashier('GET', '/location-products')).status).toBe(200);
    expect((await cashier('PUT', `/location-products/${productId}`, { is_available: true })).status).toBe(403);
  });

  it('sets stock per location, allowing negative quantities', async () => {
    const loc1 = await client(app, orgA.users.ADMIN, orgA.locations[0]);
    const res = await loc1('PUT', `/location-stock/${ingredientId}`, { current_qty: -250.5, min_alert_qty: 1000 });
    expect(res.body).toMatchObject({ current_qty: '-250.5', min_alert_qty: '1000' });
    expect((await loc1('PUT', `/location-stock/${ingredientId}`, { min_alert_qty: -1 })).status).toBe(400);

    const stock = (await loc1('GET', '/location-stock')).body;
    expect(stock).toEqual([expect.objectContaining({ ingredient_id: ingredientId, ingredients: { name: 'Harina', unit: 'gr' } })]);
  });
});
