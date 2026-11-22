// Integration test: real app over HTTP + Postgres with migrations applied.
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg; // SINGLE
let ownerA: Call;
let cashierA: Call;
let ownerB: Call;

const modifiers = [
  { name: 'Tamaño', required: true, multiple: false, options: [{ name: 'Grande', price_cop: 2000 }, { name: 'Pequeño', price_cop: 0 }] },
];

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  ownerA = await client(app, orgA.users.OWNER);
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
    const drinks = await ownerA('POST', '/categories', { name: 'Bebidas', sort_order: 2 });
    const food = await ownerA('POST', '/categories', { name: 'Comidas', sort_order: 1 });
    expect([drinks.status, food.status]).toEqual([201, 201]);

    const list = await cashierA('GET', '/categories');
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Comidas', 'Bebidas']);

    const renamed = await ownerA('PATCH', `/categories/${drinks.body.id}`, { name: 'Bebidas frías' });
    expect(renamed.body.name).toBe('Bebidas frías');

    const product = await db.products.create({
      data: { organization_id: orgA.id, category_id: food.body.id, name: 'Arepa', base_price_cop: 5000 },
    });
    expect((await ownerA('DELETE', `/categories/${food.body.id}`)).status).toBe(204);
    expect((await ownerA('DELETE', `/categories/${food.body.id}`)).status).toBe(404);
    // Products survive without category (composite FK sets only category_id to NULL).
    await expect(db.products.findUnique({ where: { id: product.id } })).resolves.toMatchObject({ category_id: null });
    await db.products.delete({ where: { id: product.id } });
  });

  it('lets only owner/admin write', async () => {
    expect((await cashierA('POST', '/categories', { name: 'x' })).status).toBe(403);
  });

  it('hides other organizations categories', async () => {
    const { body } = await ownerA('POST', '/categories', { name: 'Privada' });
    expect((await ownerB('GET', '/categories')).body).toEqual([]);
    expect((await ownerB('PATCH', `/categories/${body.id}`, { name: 'x' })).status).toBe(404);
    expect((await ownerB('DELETE', `/categories/${body.id}`)).status).toBe(404);
  });

  it('validates the body', async () => {
    expect((await ownerA('POST', '/categories', { name: '   ' })).status).toBe(400);
    expect((await ownerA('POST', '/categories', { name: 'x', sort_order: 1.5 })).status).toBe(400);
    expect((await ownerA('POST', '/categories', ['x'])).status).toBe(400);
  });
});

describe('products', () => {
  let productId: string;

  it('creates a product with modifiers', async () => {
    const res = await ownerA('POST', '/products', {
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
    expect((await ownerA('POST', '/products', body)).status).toBe(400);
  });

  it('rejects a category of another organization', async () => {
    const { body: categoryB } = await ownerB('POST', '/categories', { name: 'De B' });
    const res = await ownerA('POST', '/products', { name: 'x', base_price_cop: 1, category_id: categoryB.id });
    expect(res.status).toBe(400);
  });

  it('lists and updates only own products', async () => {
    expect((await cashierA('GET', '/products')).body.map((p: { id: string }) => p.id)).toEqual([productId]);
    expect((await ownerB('GET', '/products')).body).toEqual([]);
    const res = await ownerA('PATCH', `/products/${productId}`, { is_active: false, description: null });
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
    expect((await ownerA('DELETE', `/products/${productId}`)).status).toBe(409);
    await db.orders.delete({ where: { id: order.id } });

    const { body: unsold } = await ownerA('POST', '/products', { name: 'Temporal', base_price_cop: 1 });
    expect((await ownerA('DELETE', `/products/${unsold.id}`)).status).toBe(204);
  });
});

describe('ingredients and recipes', () => {
  let productId: string;
  let milk: string;
  let coffee: string;

  beforeAll(async () => {
    productId = (await ownerA('POST', '/products', { name: 'Capuchino', base_price_cop: 7000 })).body.id;
  });

  it('creates, lists, updates and deletes ingredients', async () => {
    milk = (await ownerA('POST', '/ingredients', { name: 'Leche', unit: 'ml' })).body.id;
    coffee = (await ownerA('POST', '/ingredients', { name: 'Café', unit: 'gr' })).body.id;
    const temp = (await ownerA('POST', '/ingredients', { name: 'Temporal', unit: 'und' })).body.id;

    expect((await ownerA('PATCH', `/ingredients/${coffee}`, { name: 'Café molido' })).body.name).toBe('Café molido');
    expect((await ownerA('DELETE', `/ingredients/${temp}`)).status).toBe(204);
    expect((await cashierA('GET', '/ingredients')).body.map((i: { name: string }) => i.name)).toEqual(['Café molido', 'Leche']);
    expect((await ownerA('POST', '/ingredients', { name: 'Azúcar' })).status).toBe(400);
    expect((await ownerB('GET', '/ingredients')).body).toEqual([]);
  });

  it('replaces the whole recipe', async () => {
    await ownerA('PUT', `/products/${productId}/recipe`, [{ ingredient_id: milk, quantity_required: 100 }]);
    const res = await ownerA('PUT', `/products/${productId}/recipe`, [
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
    expect((await ownerA('PUT', path, { ingredient_id: milk })).status).toBe(400);
    expect((await ownerA('PUT', path, [{ ingredient_id: milk, quantity_required: 0 }])).status).toBe(400);
    const duplicated = [milk, milk].map((id) => ({ ingredient_id: id, quantity_required: 1 }));
    expect((await ownerA('PUT', path, duplicated)).status).toBe(409);
    // The failed replacement rolled back: the previous recipe is intact.
    expect((await ownerA('GET', path)).body).toHaveLength(2);
  });

  it('isolates recipes between organizations', async () => {
    const { body: ingredientB } = await ownerB('POST', '/ingredients', { name: 'Leche B', unit: 'ml' });
    const res = await ownerA('PUT', `/products/${productId}/recipe`, [{ ingredient_id: ingredientB.id, quantity_required: 1 }]);
    expect(res.status).toBe(400);
    expect((await ownerB('PUT', `/products/${productId}/recipe`, [])).status).toBe(404);
    expect((await ownerB('GET', `/products/${productId}/recipe`)).body).toEqual([]);
  });
});

describe('per-location prices, availability and stock', () => {
  let productId: string;
  let ingredientId: string;

  beforeAll(async () => {
    productId = (await ownerA('POST', '/products', { name: 'Brownie', base_price_cop: 6000 })).body.id;
    ingredientId = (await ownerA('POST', '/ingredients', { name: 'Harina', unit: 'gr' })).body.id;
  });

  it('sets price and availability for the request location only', async () => {
    const loc1 = await client(app, orgA.users.OWNER, orgA.locations[0]);
    const loc2 = await client(app, orgA.users.OWNER, orgA.locations[1]);

    expect((await loc1('PUT', `/location-products/${productId}`, { custom_price_cop: 6500 })).status).toBe(200);
    const res = await loc1('PUT', `/location-products/${productId}`, { is_available: false });
    expect(res.body).toMatchObject({ location_id: orgA.locations[0], custom_price_cop: '6500', is_available: false });

    expect((await loc1('GET', '/location-products')).body).toHaveLength(1);
    expect((await loc2('GET', '/location-products')).body).toEqual([]);
  });

  it('requires a location on MULTI and rejects locations of another organization', async () => {
    expect((await ownerA('GET', '/location-products')).status).toBe(400);
    const foreign = await client(app, orgA.users.OWNER, orgB.locations[0]);
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
    const loc1 = await client(app, orgA.users.OWNER, orgA.locations[0]);
    const res = await loc1('PUT', `/location-stock/${ingredientId}`, { current_qty: -250.5, min_alert_qty: 1000 });
    expect(res.body).toMatchObject({ current_qty: '-250.5', min_alert_qty: '1000' });
    expect((await loc1('PUT', `/location-stock/${ingredientId}`, { min_alert_qty: -1 })).status).toBe(400);

    const stock = (await loc1('GET', '/location-stock')).body;
    expect(stock).toEqual([expect.objectContaining({ ingredient_id: ingredientId, ingredients: { name: 'Harina', unit: 'gr' } })]);
  });

  it('adds received goods on top of the current stock, creating the row when missing', async () => {
    const loc2 = await client(app, orgA.users.CASHIER, orgA.locations[1]);
    const first = await loc2('POST', `/location-stock/${ingredientId}/receive`, { qty: 1000 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ location_id: orgA.locations[1], current_qty: '1000' });
    expect((await loc2('POST', `/location-stock/${ingredientId}/receive`, { qty: 250.5 })).body).toMatchObject({ current_qty: '1250.5' });

    for (const qty of [0, -5, '10', undefined]) {
      expect((await loc2('POST', `/location-stock/${ingredientId}/receive`, { qty })).status).toBe(400);
    }
    // Ingredient of another organization: the composite FK rejects it.
    const other = (await ownerB('POST', '/ingredients', { name: 'Sal', unit: 'gr' })).body.id;
    expect((await loc2('POST', `/location-stock/${other}/receive`, { qty: 1 })).status).toBe(400);
  });

  it('lets cashiers count stock but not manage ingredients', async () => {
    const cashier = await client(app, orgA.users.CASHIER, orgA.locations[0]);
    expect((await cashier('PUT', `/location-stock/${ingredientId}`, { current_qty: 10, min_alert_qty: 5 })).status).toBe(200);
    expect((await cashier('POST', '/ingredients', { name: 'Azúcar', unit: 'gr' })).status).toBe(403);
    expect((await cashier('PATCH', `/ingredients/${ingredientId}`, { name: 'x' })).status).toBe(403);
    expect((await cashier('DELETE', `/ingredients/${ingredientId}`)).status).toBe(403);
  });
});

describe('catalog per location (Q43)', () => {
  it('creates a product of the request location only with only_here', async () => {
    const loc1 = await client(app, orgA.users.OWNER, orgA.locations[0]);
    const own = await loc1('POST', '/products', { name: 'Arepa de la casa', base_price_cop: 7000, only_here: true });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ location_id: orgA.locations[0] });
    expect(own.body).not.toHaveProperty('only_here');
    expect((await loc1('POST', '/products', { name: 'Café de la cadena', base_price_cop: 3000 })).body.location_id).toBeNull();
    // The location never comes from the body (dropped by the whitelist), and only_here needs a request location.
    expect((await loc1('POST', '/products', { name: 'x', base_price_cop: 1, location_id: orgA.locations[1] })).body.location_id).toBeNull();
    expect((await ownerA('POST', '/products', { name: 'x', base_price_cop: 1, only_here: true })).status).toBe(400);
  });

  it('lists only the ingredients a location works with', async () => {
    const loc1 = await client(app, orgA.users.OWNER, orgA.locations[0]);
    const loc2 = await client(app, orgA.users.OWNER, orgA.locations[1]);
    const ingredient = async (name: string) => (await loc1('POST', '/ingredients', { name, unit: 'gr' })).body.id as string;
    const product = async (name: string, ingredientIds: string[], only_here = false) => {
      const id = (await loc1('POST', '/products', { name, base_price_cop: 1000, only_here })).body.id as string;
      await loc1('PUT', `/products/${id}/recipe`, ingredientIds.map((ingredient_id) => ({ ingredient_id, quantity_required: 1 })));
      return id;
    };
    const ownOnly = await ingredient('Q43 solo sede 1');
    const stocked = await ingredient('Q43 con stock en sede 2');
    const unlisted = await ingredient('Q43 de producto no listado');
    const shared = await ingredient('Q43 de la cadena');
    await ingredient('Q43 sin receta');
    await product('Q43 propio', [ownOnly, stocked], true);
    const dropped = await product('Q43 no se vende en sede 2', [unlisted]);
    await product('Q43 cadena', [shared]);

    const res = await loc2('PUT', `/location-products/${dropped}`, { is_listed: false });
    expect(res.body).toMatchObject({ is_listed: false, is_available: true });
    await loc2('POST', `/location-stock/${stocked}/receive`, { qty: 10 });

    const names = async (call: Call, query = '?here=1') =>
      ((await call('GET', `/ingredients${query}`)).body as { name: string }[]).map((i) => i.name).filter((n) => n.startsWith('Q43'));
    expect(await names(loc2)).toEqual(['Q43 con stock en sede 2', 'Q43 de la cadena', 'Q43 sin receta']);
    expect(await names(loc1)).toHaveLength(5);
    expect(await names(loc2, '')).toHaveLength(5);
    expect((await ownerA('GET', '/ingredients?here=1')).status).toBe(400);
  });
});

describe('supervisor (Q53)', () => {
  it('reads the catalog and only marks products sold out at its location', async () => {
    const { body: product } = await ownerA('POST', '/products', { name: 'Arepa', base_price_cop: 5000 });
    const supervisor = await client(app, orgA.users.ADMIN, orgA.locations[0]);
    expect((await supervisor('GET', '/products')).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '/products', { name: 'Otra', base_price_cop: 1000 }],
      ['PATCH', `/products/${product.id}`, { base_price_cop: 1 }],
      ['PUT', `/products/${product.id}/recipe`, { items: [] }],
      ['DELETE', `/products/${product.id}`, undefined],
      ['POST', '/categories', { name: 'Nueva' }],
      ['POST', '/ingredients', { name: 'Sal', unit: 'gr' }],
      ['PUT', `/location-products/${product.id}`, { custom_price_cop: 4000 }],
      ['PUT', `/location-products/${product.id}`, { is_listed: false }],
    ] as const) {
      expect((await supervisor(method, path, body)).status).toBe(403);
    }
    const soldOut = await supervisor('PUT', `/location-products/${product.id}`, { is_available: false });
    expect(soldOut.status).toBe(200);
    expect(soldOut.body).toMatchObject({ is_available: false, custom_price_cop: null, is_listed: true });
  });
});
