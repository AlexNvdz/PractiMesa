// Integration test: real app over HTTP + Postgres; Factus is a fake (no network call leaves the machine).
import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Call, client, createOrg, startApp, TestOrg } from '../testing/http';
import { InvoicingService, MAX_ATTEMPTS } from './invoicing.service';

const FACTUS = 'https://factus.test';
type Reply = { status: number; body: unknown };
const validated = (ref: string): Reply => ({
  status: 201,
  body: { status: 'Created', data: { is_validated: true, number: `SETP-${ref.slice(0, 4)}`, cufe: `cufe-${ref}`, links: { qr: 'https://dian.test/qr', public_url: 'https://factus.test/pdf' } } },
});

/** Factus as documented and as the sandbox answered: OAuth2 password/refresh grants, bills by reference. */
class FakeFactus {
  passwords = new Map([['demo@factus.test', 'right'], ['own@factus.test', 'own-pass']]);
  expiresIn = 3600;
  grants: { type: string; username?: string }[] = [];
  tokens = new Set<string>();
  bills: Record<string, any>[] = [];
  deleted: string[] = [];
  next: (ref: string) => Reply = validated;
  private n = 0;

  handle(url: string, init?: RequestInit): Response {
    const path = url.slice(FACTUS.length);
    const reply = ({ status, body }: Reply) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/oauth/token') {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      const type = form.get('grant_type')!;
      const ok =
        form.get('client_id') === 'cid' &&
        form.get('client_secret') === 'csecret' &&
        (type === 'refresh_token' ? form.get('refresh_token') === 'refresh' : this.passwords.get(form.get('username')!) === form.get('password'));
      if (!ok) return reply({ status: 401, body: { error: 'invalid_grant' } });
      this.grants.push({ type, username: form.get('username') ?? undefined });
      const token = `t${++this.n}`;
      this.tokens.add(token);
      return reply({ status: 200, body: { token_type: 'Bearer', expires_in: this.expiresIn, access_token: token, refresh_token: 'refresh' } });
    }
    const token = (init?.headers as Record<string, string>).Authorization.replace('Bearer ', '');
    if (!this.tokens.has(token)) return reply({ status: 401, body: { message: 'Unauthenticated.' } });
    if (path === '/v2/bills/validate') {
      const bill = JSON.parse(init!.body as string);
      this.bills.push(bill);
      return reply(this.next(bill.reference_code));
    }
    this.deleted.push(decodeURIComponent(path.replace('/v2/bills/destroy/reference/', '')));
    return reply({ status: 200, body: { status: 'OK' } });
  }
}

const db = new PrismaService();
const fake = new FakeFactus();
const env = { ...process.env };
let app: INestApplication;
let invoicing: InvoicingService;
let orgA: TestOrg; // shared (environment) Factus account
let orgB: TestOrg; // its own Factus account
let cashierA: Call;
let ownerB: Call;
let cashierB: Call;
let waiterA: Call;
let product: string;

/** Paid PICKUP order of org A (one product at 32000, impoconsumo 8%). */
async function paidOrder(tip?: object) {
  const { body } = await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: product, quantity: 1 }] });
  await cashierA('POST', `/orders/${body.id}/pay`, { payment_method: 'CASH', ...tip });
  return body.id as string;
}
const invoice = (call: Call, id: string, body: object = {}) => call('POST', `/orders/${id}/invoice`, body);
const state = (id: string) => db.orders.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  Object.assign(process.env, {
    FACTUS_API_URL: FACTUS,
    FACTUS_CLIENT_ID: 'cid',
    FACTUS_CLIENT_SECRET: 'csecret',
    FACTUS_USERNAME: 'demo@factus.test',
    FACTUS_PASSWORD: 'right',
    FACTUS_NUMBERING_RANGE_ID: '389',
    CREDENTIALS_KEY: randomBytes(32).toString('base64'),
  });
  const realFetch = globalThis.fetch;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(FACTUS)) return fake.handle(url, init);
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1?\])/.test(url)) return realFetch(input, init);
    throw new Error(`Unexpected network call: ${url}`);
  });

  app = await startApp();
  invoicing = app.get(InvoicingService);
  orgA = await createOrg(db, 'SINGLE', 1);
  orgB = await createOrg(db, 'SINGLE', 1);
  product = (await db.products.create({ data: { organization_id: orgA.id, name: 'Bandeja paisa', base_price_cop: 32000, tax_rate: 8 } })).id;
  const waiter = await db.users.create({
    data: { organization_id: orgA.id, email: `waiter-${orgA.id}@test.demo`, password_hash: 'x', full_name: 'Mesero', role: 'WAITER' },
  });
  cashierA = await client(app, orgA.users.CASHIER);
  waiterA = await client(app, waiter.id);
  ownerB = await client(app, orgB.users.OWNER);
  cashierB = await client(app, orgB.users.CASHIER);
  await cashierA('POST', '/cash-registers', { opening_amount_cop: 0 });
});

afterAll(async () => {
  await db.organizations.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  await db.$disconnect();
  await app.close();
  jest.restoreAllMocks();
  process.env = env;
});

describe('requesting an invoice', () => {
  it('waits until the order is paid, then the job emits it to consumidor final', async () => {
    const { body: order } = await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: product, quantity: 1 }] });
    const res = await invoice(cashierA, order.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ factus_status: 'PENDING', invoice_customer: null });
    expect(fake.bills).toHaveLength(0);

    await cashierA('POST', `/orders/${order.id}/pay`, { payment_method: 'CASH', tip_percent: 10 });
    await invoicing.processPending();
    await expect(state(order.id)).resolves.toMatchObject({
      factus_status: 'VALIDATED',
      factus_attempts: 1,
      factus_invoice_number: `SETP-${order.id.slice(0, 4)}`,
      factus_cufe: `cufe-${order.id}`,
      factus_qr_url: 'https://dian.test/qr',
      factus_pdf_url: 'https://factus.test/pdf',
      factus_error: null,
    });
    // 32000 paid + 10% tip over the 29629.63 subtotal (2963): the invoice total is what was paid.
    expect(fake.bills.at(-1)).toMatchObject({
      reference_code: order.id,
      numbering_range_id: 389,
      customer: { identification: '222222222222', names: 'Consumidor Final' },
      payment_details: [{ payment_method_code: '10', amount: '34963.00' }],
      allowance_charges: [{ reason: 'propina', amount: '2963.00' }],
    });
    expect(fake.grants.at(-1)).toEqual({ type: 'password', username: 'demo@factus.test' });
  });

  it('emits right away for a paid order and keeps a customer who gives a phone', async () => {
    const id = await paidOrder();
    const customer = {
      identification_document_code: '31',
      identification: '900123456',
      legal_organization_code: '1',
      company: 'ACME SAS',
      email: 'compras@acme.test',
      phone: '3001234567',
    };
    const res = await invoice(cashierA, id, { customer });
    expect(res.body).toMatchObject({ factus_status: 'VALIDATED', invoice_customer: customer });
    expect(fake.bills.at(-1)!.customer).toEqual(customer);
    const saved = await db.customers.findFirstOrThrow({ where: { organization_id: orgA.id, phone: '3001234567' } });
    expect(saved).toMatchObject({ full_name: 'ACME SAS', identification_type: '31', identification_number: '900123456' });
    await expect(state(id)).resolves.toMatchObject({ customer_id: saved.id });
  });

  it('refuses duplicates, cancelled or foreign orders, other roles and incomplete customers', async () => {
    const id = await paidOrder();
    await invoice(cashierA, id);
    expect((await invoice(cashierA, id)).status).toBe(409);

    const { body: cancelled } = await cashierA('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: product, quantity: 1 }] });
    await cashierA('POST', `/orders/${cancelled.id}/cancel`);
    expect((await invoice(cashierA, cancelled.id)).status).toBe(409);
    expect((await invoice(cashierB, id)).status).toBe(404);
    expect((await invoice(waiterA, id)).status).toBe(403);

    const other = await paidOrder();
    const person = { identification_document_code: '13', identification: '1020304050', legal_organization_code: '2' };
    expect((await invoice(cashierA, other, { customer: person })).status).toBe(400); // no names
    expect((await invoice(cashierA, other, { customer: { ...person, names: 'Ana', identification_document_code: '99' } })).status).toBe(400);
    expect((await invoice(cashierA, other, { customer: { ...person, names: 'Ana', email: 'no-email' } })).status).toBe(400);
  });
});

describe('Factus answers', () => {
  afterEach(() => {
    fake.next = validated;
    fake.expiresIn = 3600;
  });

  it('stops at once when Factus rejects our data, and can be requested again', async () => {
    fake.next = () => ({
      status: 422,
      body: { status: 'Validation error', data: { message: 'Error de validación', errors: { 'customer.names': ['El campo nombre es obligatorio.'] } } },
    });
    const id = await paidOrder();
    expect((await invoice(cashierA, id)).body).toMatchObject({
      factus_status: 'ERROR',
      factus_error: 'customer.names: El campo nombre es obligatorio.',
    });

    fake.next = validated;
    expect((await invoice(cashierA, id)).body.factus_status).toBe('VALIDATED');
  });

  it('retries server errors until the attempt limit', async () => {
    fake.next = () => ({ status: 503, body: { message: 'Mantenimiento' } });
    const id = await paidOrder();
    expect((await invoice(cashierA, id)).body).toMatchObject({ factus_status: 'PENDING', factus_error: 'Mantenimiento' });
    await db.orders.update({ where: { id }, data: { factus_attempts: MAX_ATTEMPTS - 1 } });
    await invoicing.processPending();
    await expect(state(id)).resolves.toMatchObject({ factus_status: 'ERROR', factus_attempts: MAX_ATTEMPTS });
  });

  it('deletes an invoice the DIAN did not validate and sends it again', async () => {
    fake.next = () => ({ status: 409, body: { message: 'Se encontró una factura pendiente por enviar a la DIAN' } });
    const id = await paidOrder();
    expect((await invoice(cashierA, id)).body.factus_status).toBe('PENDING');
    expect(fake.deleted.at(-1)).toBe(id);

    fake.next = () => ({ status: 201, body: { data: { is_validated: false, errors: { FAJ44b: 'Nit no corresponde' } } } });
    await invoicing.processPending();
    await expect(state(id)).resolves.toMatchObject({ factus_status: 'PENDING', factus_attempts: 2, factus_error: 'FAJ44b: Nit no corresponde' });

    fake.next = validated;
    await invoicing.processPending();
    await expect(state(id)).resolves.toMatchObject({ factus_status: 'VALIDATED', factus_attempts: 3 });
  });

  it('logs in again after a 401 and refreshes a token about to expire', async () => {
    fake.tokens.clear(); // revoked on Factus' side
    fake.expiresIn = 30; // under the one-minute margin
    const grants = fake.grants.length;
    expect((await invoice(cashierA, await paidOrder())).body.factus_status).toBe('VALIDATED');
    expect(fake.grants.slice(grants).map((g) => g.type)).toEqual(['password']);

    expect((await invoice(cashierA, await paidOrder())).body.factus_status).toBe('VALIDATED');
    expect(fake.grants.at(-1)!.type).toBe('refresh_token');
  });

  it('keeps retrying while no Factus account is configured', async () => {
    const id = await paidOrder();
    delete process.env.FACTUS_CLIENT_ID;
    expect((await invoice(cashierA, id)).body).toMatchObject({ factus_status: 'PENDING', factus_error: 'Factus no está configurado para este negocio' });
    process.env.FACTUS_CLIENT_ID = 'cid';
  });
});

describe('a business with its own Factus account', () => {
  it('stores it sealed (owner only, secrets never returned) and invoices with it', async () => {
    expect((await cashierB('PUT', '/integrations/factus', {})).status).toBe(403);
    const put = (body: object) => ownerB('PUT', '/integrations/factus', body);
    const account = { client_id: 'cid', client_secret: 'csecret', username: 'own@factus.test', password: 'own-pass', numbering_range_id: 77 };
    expect((await put({ ...account, password: 'wrong' })).status).toBe(400);
    expect((await put({ ...account, username: 'no-email' })).status).toBe(400);
    const saved = await put(account);
    expect(saved.body.factus).toMatchObject({ configured: true });
    expect(JSON.stringify(saved.body)).not.toMatch(/own-pass|csecret/);

    const juice = await db.products.create({ data: { organization_id: orgB.id, name: 'Jugo', base_price_cop: 8000, tax_rate: 8 } });
    await cashierB('POST', '/cash-registers', { opening_amount_cop: 0 });
    const { body: order } = await cashierB('POST', '/orders', { order_type: 'PICKUP', items: [{ product_id: juice.id, quantity: 1 }] });
    await cashierB('POST', `/orders/${order.id}/pay`, { payment_method: 'MANUAL_TRANSFER' });
    expect((await invoice(cashierB, order.id)).body.factus_status).toBe('VALIDATED');
    // Range 77 only exists in the business's own account: the invoice went through it.
    expect(fake.bills.at(-1)).toMatchObject({ numbering_range_id: 77, payment_details: [{ payment_method_code: '47', amount: '8000.00' }] });

    expect((await ownerB('DELETE', '/integrations/factus')).status).toBe(204);
    expect((await ownerB('GET', '/integrations')).body.factus.configured).toBe(false);
  });
});
