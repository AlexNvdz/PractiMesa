import { Prisma } from '../generated/prisma/client';
import { FINAL_CONSUMER, invoicePayload, OrderForInvoice } from './invoice-payload';

const D = (v: number) => new Prisma.Decimal(v);
const line = (name: string, price: number, rate: number, quantity: number, options: string[] = []) => ({
  product_id: `p-${name}`,
  quantity,
  unit_price_cop: D(price),
  tax_rate: D(rate),
  selected_modifiers: options.map((option) => ({ group: 'g', option })),
  products: { name },
});

describe('invoicePayload', () => {
  // The same order Factus sandbox validated (SETP990038710): total 76963.01 before rounding.
  const order: OrderForInvoice = {
    id: 'order-1',
    order_number: 7,
    payment_method: 'FACTUS_PAY_QR',
    total_cop: D(73000),
    tip_cop: D(3963),
    invoice_customer: null,
    order_items: [line('Bandeja paisa', 32000, 8, 1), line('Latte', 11500, 8, 2, ['Grande']), line('Agua', 6000, 19, 3)],
  };

  it('sends net prices, impoconsumo/IVA codes, the tip as surcharge and the rounding to what was paid', () => {
    const body = invoicePayload(order, 389);
    expect(body).toMatchObject({
      reference_code: 'order-1',
      numbering_range_id: 389,
      observation: 'Pedido #7',
      customer: FINAL_CONSUMER,
      payment_details: [{ payment_form: '1', payment_method_code: '47', amount: '76963.00' }],
      cash_rounding_amount: '-0.01',
      allowance_charges: [{ concept_type: '03', is_surcharge: true, reason: 'propina', base_amount: '66051.99', amount: '3963.00' }],
    });
    expect(body.items.map((i) => [i.name, i.quantity, i.price, i.taxes])).toEqual([
      ['Bandeja paisa', '1', '29629.63', [{ code: '04', rate: '8.00' }]],
      ['Latte (Grande)', '2', '10648.15', [{ code: '04', rate: '8.00' }]],
      ['Agua', '3', '5042.02', [{ code: '01', rate: '19.00' }]],
    ]);
  });

  it('omits what does not apply: tip, rounding, range; excludes untaxed items; keeps the customer given', () => {
    const customer = { identification_document_code: '31', identification: '900123456', legal_organization_code: '1', company: 'ACME SAS' };
    const body = invoicePayload({
      ...order,
      payment_method: 'CASH',
      total_cop: D(10000),
      tip_cop: D(0),
      invoice_customer: customer,
      order_items: [line('Pan', 5000, 0, 2)],
    });
    expect(body).not.toHaveProperty('numbering_range_id');
    expect(body).not.toHaveProperty('allowance_charges');
    expect(body).not.toHaveProperty('cash_rounding_amount');
    expect(body.customer).toEqual(customer);
    expect(body.payment_details).toEqual([{ payment_form: '1', payment_method_code: '10', amount: '10000.00' }]);
    expect(body.items[0]).toMatchObject({ price: '5000.00', taxes: [{ is_excluded: true }], unit_measure_code: '94', standard_code: '999' });
  });
});
