// Integration test: real app over HTTP + Postgres (migration 0010 triggers + LISTEN) + SSE streams.
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';
import { LiveEvent, LiveEventsService } from './live-events.service';

const db = new PrismaService();
let app: INestApplication;
let orgA: TestOrg; // MULTI, 2 locations
let orgB: TestOrg; // SINGLE
let cashier1: Call;
let admin2: Call;
let ownerB: Call;
let productA: string;
let productB: string;
let table: string;

interface Stream {
  status: number;
  /** Raw SSE blocks received, e.g. "event: order\ndata: {...}". */
  blocks: string[];
  ended: boolean;
  close(): void;
}

async function open(userId: string, locationId?: string, expiresIn = 900): Promise<Stream> {
  const token = await app.get(JwtService).signAsync({ sub: userId }, { expiresIn });
  const abort = new AbortController();
  const res = await fetch(`${await app.getUrl()}/api/events`, {
    headers: { authorization: `Bearer ${token}`, ...(locationId ? { 'x-location-id': locationId } : {}) },
    signal: abort.signal,
  });
  const stream: Stream = { status: res.status, blocks: [], ended: false, close: () => abort.abort() };
  void (async () => {
    let buffer = '';
    try {
      for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!;
        stream.blocks.push(...parts);
      }
    } catch {
      // aborted by the test
    }
    stream.ended = true;
  })();
  return stream;
}

const events = (s: Stream) => s.blocks.filter((b) => b.startsWith('event:'));
const event = (type: string, id: string) => `event: ${type}\ndata: ${JSON.stringify({ id })}`;

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const item = (product_id: string) => ({ items: [{ product_id, quantity: 1 }] });

beforeAll(async () => {
  app = await startApp();
  orgA = await createOrg(db, 'MULTI', 2);
  orgB = await createOrg(db, 'SINGLE', 1);
  productA = (await db.products.create({ data: { organization_id: orgA.id, name: 'Tinto', base_price_cop: 3000 } })).id;
  productB = (await db.products.create({ data: { organization_id: orgB.id, name: 'Tinto', base_price_cop: 3000 } })).id;
  table = (await db.dining_tables.create({ data: { organization_id: orgA.id, location_id: orgA.locations[0], name: 'Mesa #1', number: 1 } }))
    .id;
  cashier1 = await client(app, orgA.users.CASHIER, orgA.locations[0]);
  admin2 = await client(app, orgA.users.ADMIN, orgA.locations[1]);
  ownerB = await client(app, orgB.users.OWNER);
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
});

describe('GET /api/events', () => {
  it('needs a login and, in a MULTI org, a location', async () => {
    expect((await fetch(`${await app.getUrl()}/api/events`)).status).toBe(401);
    const noLocation = await open(orgA.users.OWNER);
    expect(noLocation.status).toBe(400);
  });

  it('streams committed changes of its own location only', async () => {
    const loc1 = await open(orgA.users.CASHIER, orgA.locations[0]);
    const loc2 = await open(orgA.users.ADMIN, orgA.locations[1]);
    const other = await open(orgB.users.OWNER);
    expect([loc1.status, loc2.status, other.status]).toEqual([200, 200, 200]);

    const dineIn = (await cashier1('POST', '/orders', { order_type: 'DINE_IN', table_id: table, ...item(productA) })).body.id;
    // Table taken and order created in one transaction: one event each.
    await until(() => events(loc1).length === 2);
    expect(events(loc1).sort()).toEqual([event('order', dineIn), event('table', table)].sort());

    await cashier1('POST', `/orders/${dineIn}/items`, item(productA));
    await until(() => events(loc1).length === 3);
    expect(events(loc1)[2]).toBe(event('order', dineIn));

    // Notifications arrive in commit order: once these show up, nothing from location 1 or org A slipped in.
    const pickup2 = (await admin2('POST', '/orders', { order_type: 'PICKUP', ...item(productA) })).body.id;
    const pickupB = (await ownerB('POST', '/orders', { order_type: 'PICKUP', ...item(productB) })).body.id;
    await until(() => events(loc2).length === 1 && events(other).length === 1);
    expect(events(loc2)).toEqual([event('order', pickup2)]);
    expect(events(other)).toEqual([event('order', pickupB)]);
    expect(events(loc1)).toHaveLength(3);
    for (const s of [loc1, loc2, other]) s.close();
  });

  it('ends the stream when the access token that opened it expires', async () => {
    const stream = await open(orgB.users.OWNER, undefined, 1);
    expect(stream.status).toBe(200);
    await until(() => stream.ended, 3000);
  });

  it('ends open streams when the database feed drops, then reconnects', async () => {
    const live = app.get(LiveEventsService) as unknown as { client: { processID: number } };
    const stream = await open(orgB.users.OWNER);
    const pid = live.client.processID;
    await db.$executeRaw`SELECT pg_terminate_backend(${pid}::int)`;
    await until(() => stream.ended);

    const next = await open(orgB.users.OWNER);
    const order = (await ownerB('POST', '/orders', { order_type: 'PICKUP', ...item(productB) })).body.id;
    // The listener may still be reconnecting: touch the order until the new stream sees it.
    for (let tries = 0; !events(next).includes(event('order', order)); tries++) {
      if (tries === 50) throw new Error('no event after reconnecting');
      await db.orders.update({ where: { id: order }, data: { status: 'CONFIRMED' } });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(live.client.processID).not.toBe(pid);
    next.close();
  });
});

describe('LiveEventsService', () => {
  it('tells subscribers to resync and retries while the database is unreachable', async () => {
    const url = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/none';
    const live = new LiveEventsService();
    const seen: (LiveEvent | null)[] = [];
    live.subscribe((e) => seen.push(e));
    try {
      live.onModuleInit();
      await until(() => seen.length > 0);
      expect(seen[0]).toBeNull();
    } finally {
      process.env.DATABASE_URL = url;
      await live.onModuleDestroy();
    }
  });
});
