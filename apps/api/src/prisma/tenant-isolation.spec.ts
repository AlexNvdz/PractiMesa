// Integration test: needs Postgres with migrations applied (npm run db:up && npm run db:migrate -w apps/api).
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';

const db = new PrismaService();
const suffix = randomUUID().slice(0, 8);

let orgA: string;
let orgB: string;
let locA1: string;
let locA2: string;
let locB: string;
let productA: string;
let productB: string;

const order = (organizationId: string, locationId: string) => ({
  organization_id: organizationId,
  location_id: locationId,
  channel: 'POS',
  order_type: 'PICKUP',
  subtotal_cop: 10000,
  tax_cop: 800,
  total_cop: 10800,
});

beforeAll(async () => {
  const newOrg = (name: string) =>
    db.organizations.create({ data: { name, slug: `${name}-${suffix}`, plan_tier: 'MULTI', max_locations: 3 } });
  orgA = (await newOrg('test-a')).id;
  orgB = (await newOrg('test-b')).id;

  const newLoc = (organizationId: string, name: string) =>
    db.locations.create({ data: { organization_id: organizationId, name, city: 'Bogotá', address: 'Calle 1' } });
  locA1 = (await newLoc(orgA, 'A1')).id;
  locA2 = (await newLoc(orgA, 'A2')).id;
  locB = (await newLoc(orgB, 'B1')).id;

  const newProduct = (organizationId: string, name: string) =>
    db.products.create({ data: { organization_id: organizationId, name, base_price_cop: 10000 } });
  productA = (await newProduct(orgA, 'Café A')).id;
  productB = (await newProduct(orgB, 'Café B')).id;
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await db.$disconnect();
});

describe('tenant isolation (RLS)', () => {
  it('lists only rows of the current organization', async () => {
    const products = await db.forTenant(orgA).products.findMany();
    expect(products.map((p) => p.id)).toEqual([productA]);
  });

  it('cannot read another organization row by id', async () => {
    await expect(db.forTenant(orgA).products.findUnique({ where: { id: productB } })).resolves.toBeNull();
  });

  it('cannot update or delete another organization rows', async () => {
    const tenant = db.forTenant(orgA);
    await expect(tenant.products.updateMany({ where: { id: productB }, data: { name: 'hacked' } })).resolves.toEqual({
      count: 0,
    });
    await expect(tenant.products.deleteMany({ where: { id: productB } })).resolves.toEqual({ count: 0 });
    await expect(db.products.findUnique({ where: { id: productB } })).resolves.toMatchObject({ name: 'Café B' });
  });

  it('rejects inserting a row for another organization', async () => {
    await expect(
      db.forTenant(orgA).products.create({ data: { organization_id: orgB, name: 'x', base_price_cop: 1 } }),
    ).rejects.toThrow();
  });

  it('fills organization_id from the tenant context when omitted', async () => {
    const created = await db.forTenant(orgA).categories.create({ data: { name: 'Bebidas' } });
    expect(created.organization_id).toBe(orgA);
  });

  it('scopes raw queries too', async () => {
    const rows = await db.forTenant(orgA).$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM products`;
    expect(Number(rows[0].n)).toBe(1);
  });

  it('sees only its own organization record', async () => {
    const orgs = await db.forTenant(orgA).organizations.findMany();
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it('has no access to webhook_events', async () => {
    await expect(db.forTenant(orgA).webhook_events.findMany()).rejects.toThrow();
  });

  it('applies the same scope inside tenantTransaction', async () => {
    const ids = await db.tenantTransaction(orgB, async (tx) => (await tx.products.findMany()).map((p) => p.id));
    expect(ids).toEqual([productB]);
  });
});

describe('cross-organization references (composite FKs)', () => {
  it('rejects an order item pointing to another organization product', async () => {
    const { id: orderId } = await db.forTenant(orgA).orders.create({ data: order(orgA, locA1) });
    await expect(
      db.forTenant(orgA).order_items.create({
        data: { order_id: orderId, product_id: productB, quantity: 1, unit_price_cop: 10000 },
      }),
    ).rejects.toThrow();
  });

  it('rejects a table on another organization location even on the system path', async () => {
    await expect(
      db.dining_tables.create({ data: { organization_id: orgA, location_id: locB, name: 'Mesa 1' } }),
    ).rejects.toThrow();
  });
});

describe('order_number', () => {
  it('numbers orders per location, without gaps under concurrency', async () => {
    const tenant = db.forTenant(orgA);
    const first = await tenant.orders.create({ data: order(orgA, locA2) });
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => tenant.orders.create({ data: order(orgA, locA2) })),
    );
    const other = await db.forTenant(orgB).orders.create({ data: order(orgB, locB) });

    expect(first.order_number).toBe(1);
    expect(concurrent.map((o) => o.order_number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    expect(other.order_number).toBe(1);
  });
});
