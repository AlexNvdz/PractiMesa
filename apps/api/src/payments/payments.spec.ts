// Integration test: real app over HTTP + Postgres; Factus Pay is a fake (no network call leaves the machine).
import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';
import { seal, unseal } from './sealed';

const PAY = 'https://pay.test';
const SHARED_KEY = 'shared-webhook-key-0123456789abcdef';
const B_KEY = 'b-webhook-key-0123456789abcdef-0123';

interface FakeCollection {
  reference_code: string;
  amount: number;
  status: string;
  qr: string;
  breb_key: string;
  owner: string;
}

/** Factus Pay as documented: /auth revokes the previous token, collections are idempotent per reference. */
class FakeFactusPay {
  passwords = new Map([['demo@pay.test', 'demo-pass'], ['b@pay.test', 'b-pass']]);
  active = new Map<string, string>();
  logins: string[] = [];
  created: { email: string; reference_code: string; amount: number }[] = [];
  collections = new Map<string, FakeCollection>();
  private n = 0;

  handle(url: string, init?: RequestInit): Response {
    const path = url.slice(PAY.length);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/auth') {
      if (this.passwords.get(body.email) !== body.password) return reply(401, { message: 'Credenciales inválidas' });
      const token = `t${++this.n}`;
      this.active.set(body.email, token);
      this.logins.push(body.email);
      return reply(200, { token });
    }
    const token = (init?.headers as Record<string, string>).Authorization.replace('Bearer ', '');
    const email = [...this.active].find(([, t]) => t === token)?.[0];
    if (!email) return reply(401, { message: 'Unauthenticated.' });
    if (path === '/v1/collections' && init?.method === 'POST') {
      const existing = this.collections.get(body.reference_code);
      if (existing) return reply(200, { status: 'success', message: 'Recaudo ya existente', data: existing });
      const created = { reference_code: body.reference_code, amount: body.amount, status: 'ready', qr: 'data:image/png;base64,QR', breb_key: '@KEY', owner: email };
      this.collections.set(created.reference_code, created);
      this.created.push({ email, reference_code: body.reference_code, amount: body.amount });
      return reply(201, { status: 'success', data: created });
    }
    const found = this.collections.get(decodeURIComponent(path.replace('/v1/collections/', '')));
    if (!found || found.owner !== email) return reply(404, { status: 'error', message: 'Recaudo no encontrado', data: null });
    return reply(200, { status: 'success', data: found });
  }
}

const db = new PrismaService();
const fake = new FakeFactusPay();
const env = { ...process.env };
let app: INestApplication;
let orgA: TestOrg; // uses the shared (environment) account
let orgB: TestOrg; // has its own account
let cashierA: Call;
let cashierB: Call;
let ownerB: Call;
let water: string;
let table: string;
let base: string;

const webhook = (path: string, reference: unknown) =>
  fetch(`${base}/api/webhooks/factus-pay${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { reference_code: reference, amount: 0, status: 'paid' } }),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => undefined) }));

beforeAll(async () => {
  Object.assign(process.env, {
    FACTUS_PAY_API_URL: PAY,
    FACTUS_PAY_EMAIL: 'demo@pay.test',
    FACTUS_PAY_PASSWORD: 'demo-pass',
    FACTUS_PAY_WEBHOOK_KEY: SHARED_KEY,
    CREDENTIALS_KEY: randomBytes(32).toString('base64'),
  });
  const realFetch = globalThis.fetch;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(PAY)) return fake.handle(url, init);
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1?\])/.test(url)) return realFetch(input, init);
    throw new Error(`Unexpected network call: ${url}`);
  });

  app = await startApp();
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  orgA = await createOrg(db, 'SINGLE', 1);
  orgB = await createOrg(db, 'SINGLE', 1);
  water = (await db.products.create({ data: { organization_id: orgA.id, name: 'Agua', base_price_cop: 6000, tax_rate: 19 } })).id;
  table = (await db.dining_tables.create({ data: { organization_id: orgA.id, location_id: orgA.locations[0], name: 'Mesa #1', number: 1 } })).id;
  cashierA = await client(app, orgA.users.CASHIER);
  cashierB = await client(app, orgB.users.CASHIER);
  ownerB = await client(app, orgB.users.OWNER);
  await cashierA('POST', '/cash-registers', { opening_amount_cop: 0 });
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
  jest.restoreAllMocks();
  process.env = env;
});

describe('sealed credentials', () => {
  it('opens only with the same key and context', () => {
    const sealed = seal('{"password":"x"}', 'org-1:FACTUS_PAY');
    expect(sealed).not.toContain('password');
    expect(unseal(sealed, 'org-1:FACTUS_PAY')).toBe('{"password":"x"}');
    expect(() => unseal(sealed, 'org-2:FACTUS_PAY')).toThrow();
  });

  it('refuses to work without a 32-byte key', () => {
    const key = process.env.CREDENTIALS_KEY;
    process.env.CREDENTIALS_KEY = 'short';
    expect(() => seal('x', 'c')).toThrow('CREDENTIALS_KEY');
    process.env.CREDENTIALS_KEY = key;
  });
});

describe('integrations', () => {
  it('stores a business own Factus Pay account, owner only, never returning secrets', async () => {
    expect((await cashierB('GET', '/integrations')).status).toBe(403);
    expect((await ownerB('GET', '/integrations')).body.factus_pay).toEqual({
      configured: false,
      updated_at: null,
      webhook_path: `/api/webhooks/factus-pay/${orgB.id}`,
    });

    const put = (body: object) => ownerB('PUT', '/integrations/factus-pay', body);
    expect((await put({ email: 'b@pay.test', password: 'wrong', webhook_key: B_KEY })).status).toBe(400);
    expect((await put({ email: 'b@pay.test', password: 'b-pass', webhook_key: 'short' })).status).toBe(400);
    expect((await put({ email: 'not-an-email', password: 'b-pass', webhook_key: B_KEY })).status).toBe(400);

    const saved = await put({ email: 'b@pay.test', password: 'b-pass', webhook_key: B_KEY });
    expect(saved.status).toBe(200);
    expect(saved.body.factus_pay.configured).toBe(true);
    expect(JSON.stringify(saved.body)).not.toMatch(/b-pass|b-webhook-key/);
    const row = await db.organization_credentials.findFirstOrThrow({ where: { organization_id: orgB.id } });
    expect(row.sealed).not.toMatch(/b-pass|b@pay/);
  });
});

describe('QR payment with the shared account', () => {
  let orderId: string;

  it('issues one QR for total + tip and freezes the account while it is pending', async () => {
    const { body } = await cashierA('POST', '/orders', { order_type: 'DINE_IN', table_id: table, items: [{ product_id: water, quantity: 2 }] });
    orderId = body.id;
    // Subtotal 12000 - 1915.97 = 10084.03; 10% = 1008.
    const qr = await cashierA('POST', `/orders/${orderId}/pay`, { payment_method: 'FACTUS_PAY_QR', tip_percent: 10 });
    expect(qr.status).toBe(201);
    expect(qr.body).toMatchObject({
      payment_method: 'FACTUS_PAY_QR',
      payment_status: 'PENDING_QR',
      tip_cop: '1008',
      factus_payment_ref: orderId,
      factus_qr_payload: 'data:image/png;base64,QR',
    });
    expect(fake.created.at(-1)).toEqual({ email: 'demo@pay.test', reference_code: orderId, amount: 13008 });

    const again = await cashierA('POST', `/orders/${orderId}/pay`, { payment_method: 'FACTUS_PAY_QR', tip_percent: 5 });
    expect(again.body.tip_cop).toBe('1008');
    expect(fake.created.filter((c) => c.reference_code === orderId)).toHaveLength(1);

    expect((await cashierA('POST', `/orders/${orderId}/items`, { items: [{ product_id: water, quantity: 1 }] })).status).toBe(409);
    expect((await cashierA('DELETE', `/orders/${orderId}/items/${body.order_items[0].id}`)).status).toBe(409);
  });

  it('rejects webhooks without the right key or reference', async () => {
    expect((await webhook(`?key=wrong-${SHARED_KEY}`, orderId)).status).toBe(401);
    expect((await webhook('', orderId)).status).toBe(401);
    expect((await webhook(`?key=${SHARED_KEY}`, 'nope')).status).toBe(400);
    expect((await webhook(`?key=${SHARED_KEY}`, '00000000-0000-4000-8000-000000000000')).body).toEqual({ result: 'ignored' });
  });

  it('marks the order paid only after Factus Pay confirms it, once', async () => {
    expect((await webhook(`?key=${SHARED_KEY}`, orderId)).body).toEqual({ result: 'not paid' });
    expect((await cashierA('GET', `/orders/${orderId}`)).body.payment_status).toBe('PENDING_QR');

    fake.collections.get(orderId)!.status = 'paid';
    const res = await webhook(`?key=${SHARED_KEY}`, orderId);
    expect(res).toEqual({ status: 200, body: { result: 'paid' } });
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ payment_status: 'PAID', status: 'COMPLETED', payment_method: 'FACTUS_PAY_QR' });
    expect(order.cash_register_id).not.toBeNull();
    await expect(db.dining_tables.findUnique({ where: { id: table } })).resolves.toMatchObject({ status: 'FREE' });
    await expect(db.webhook_events.count({ where: { external_event_id: orderId } })).resolves.toBe(1);

    expect((await webhook(`?key=${SHARED_KEY}`, orderId)).body).toEqual({ result: 'not pending' });
  });

  it('does not settle a payment of another amount; the order can still be paid in cash', async () => {
    const { body } = await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 2 }] });
    await cashierA('POST', `/orders/${body.id}/pay`, { payment_method: 'FACTUS_PAY_QR' });
    Object.assign(fake.collections.get(body.id)!, { status: 'paid', amount: 1000 });
    expect((await webhook(`?key=${SHARED_KEY}`, body.id)).body).toEqual({ result: 'amount mismatch' });

    const cash = await cashierA('POST', `/orders/${body.id}/pay`, { payment_method: 'CASH' });
    expect(cash.body).toMatchObject({ payment_status: 'PAID', payment_method: 'CASH' });
  });

  it('logs in again once when the token was revoked', async () => {
    fake.active.set('demo@pay.test', 'revoked-by-another-login');
    const logins = fake.logins.length;
    const { body } = await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 2 }] });
    expect((await cashierA('POST', `/orders/${body.id}/pay`, { payment_method: 'FACTUS_PAY_QR' })).status).toBe(201);
    expect(fake.logins.length).toBe(logins + 1);
  });

  it('checks the Factus Pay amount range and that some account exists', async () => {
    // 9999 is below the minimum the API enforces.
    const candy = await db.products.create({ data: { organization_id: orgA.id, name: 'Dulce', base_price_cop: 9999 } });
    const { body } = await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: candy.id, quantity: 1 }] });
    expect((await cashierA('POST', `/orders/${body.id}/pay`, { payment_method: 'FACTUS_PAY_QR' })).status).toBe(400);

    delete process.env.FACTUS_PAY_EMAIL;
    expect((await cashierA('POST', `/orders/${body.id}/pay`, { payment_method: 'FACTUS_PAY_QR' })).status).toBe(503);
    process.env.FACTUS_PAY_EMAIL = 'demo@pay.test';
  });
});

describe('QR payment with the business own account', () => {
  it('charges into the business account and only its own webhook settles it', async () => {
    const product = await db.products.create({ data: { organization_id: orgB.id, name: 'Jugo', base_price_cop: 12000 } });
    const { body } = await cashierB('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: product.id, quantity: 1 }] });
    expect((await cashierB('POST', `/orders/${body.id}/pay`, { payment_method: 'FACTUS_PAY_QR' })).status).toBe(409); // no register

    await cashierB('POST', '/cash-registers', { opening_amount_cop: 0 });
    await cashierB('POST', `/orders/${body.id}/pay`, { payment_method: 'FACTUS_PAY_QR' });
    expect(fake.created.at(-1)).toMatchObject({ email: 'b@pay.test', reference_code: body.id, amount: 12000 });
    fake.collections.get(body.id)!.status = 'paid';

    expect((await webhook(`?key=${SHARED_KEY}`, body.id)).body).toEqual({ result: 'ignored' });
    expect((await webhook(`/${orgA.id}?key=${SHARED_KEY}`, body.id)).status).toBe(401); // orgA has no own account
    expect((await webhook(`/${orgB.id}?key=${SHARED_KEY}`, body.id)).status).toBe(401);
    expect((await webhook(`/${orgB.id}?key=${B_KEY}`, body.id)).body).toEqual({ result: 'paid' });

    const fromA = (await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: water, quantity: 1 }] })).body;
    expect((await webhook(`/${orgB.id}?key=${B_KEY}`, fromA.id)).body).toEqual({ result: 'ignored' });
  });

  it('goes back to the shared account when the owner removes it', async () => {
    expect((await cashierB('DELETE', '/integrations/factus-pay')).status).toBe(403);
    expect((await ownerB('DELETE', '/integrations/factus-pay')).status).toBe(204);
    expect((await ownerB('GET', '/integrations')).body.factus_pay.configured).toBe(false);
  });
});
