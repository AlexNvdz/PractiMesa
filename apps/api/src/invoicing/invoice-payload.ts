import { Prisma } from '../generated/prisma/client';

/** Factus customer fields (only the ones we collect). */
export interface InvoiceCustomer {
  identification_document_code: string;
  identification: string;
  dv?: string;
  legal_organization_code: string;
  names?: string;
  company?: string;
  email?: string;
  phone?: string;
  address?: string;
  municipality_code?: string;
}

/** DIAN "consumidor final": used when the customer asks for an invoice without giving their data. */
export const FINAL_CONSUMER = { identification_document_code: '13', identification: '222222222222', names: 'Consumidor Final' };

/** DIAN payment method codes (Factus table): 10 efectivo, 47 transferencia (Bre-B QR is a transfer). */
const PAYMENT_METHOD_CODE: Record<string, string> = { CASH: '10', MANUAL_TRANSFER: '47', FACTUS_PAY_QR: '47' };

export interface OrderForInvoice {
  id: string;
  order_number: number;
  payment_method: string | null;
  total_cop: Prisma.Decimal;
  tip_cop: Prisma.Decimal;
  invoice_customer: unknown;
  order_items: {
    product_id: string;
    quantity: number;
    unit_price_cop: Prisma.Decimal;
    tax_rate: Prisma.Decimal;
    selected_modifiers: unknown;
    products: { name: string };
  }[];
}

const cents = (d: Prisma.Decimal) => d.toDecimalPlaces(2);

/**
 * POST /v2/bills/validate body. Our prices include tax and Factus wants the net unit price, so each price is
 * divided by (1 + rate); Factus adds the tax back per line (same rounding as here, checked against the sandbox).
 * The cents that rounding leaves go as cash_rounding_amount, and the voluntary tip as a "propina" surcharge
 * (no tax), so the invoice total is exactly what the customer paid.
 */
export function invoicePayload(order: OrderForInvoice, numberingRangeId?: number) {
  let net = new Prisma.Decimal(0);
  let total = new Prisma.Decimal(0);
  const items = order.order_items.map((item) => {
    const rate = new Prisma.Decimal(item.tax_rate);
    const price = cents(new Prisma.Decimal(item.unit_price_cop).dividedBy(rate.dividedBy(100).plus(1)));
    const lineNet = cents(price.times(item.quantity));
    net = net.plus(lineNet);
    total = total.plus(lineNet).plus(cents(lineNet.times(rate).dividedBy(100)));
    const options = (item.selected_modifiers as { option: string }[]).map((m) => m.option);
    return {
      code_reference: item.product_id,
      name: options.length ? `${item.products.name} (${options.join(', ')})` : item.products.name,
      quantity: String(item.quantity),
      price: price.toFixed(2),
      unit_measure_code: '94',
      standard_code: '999',
      // shortcut: the tax type is inferred from the rate (8% = impoconsumo 04, else IVA 01); store it per product if a business sells IVA at 8%.
      taxes: rate.isZero() ? [{ is_excluded: true }] : [{ code: rate.equals(8) ? '04' : '01', rate: rate.toFixed(2) }],
    };
  });
  const tip = cents(new Prisma.Decimal(order.tip_cop));
  const paid = cents(new Prisma.Decimal(order.total_cop)).plus(tip);
  const rounding = paid.minus(total.plus(tip));
  const body = {
    reference_code: order.id,
    ...(numberingRangeId ? { numbering_range_id: numberingRangeId } : {}),
    observation: `Pedido #${order.order_number}`,
    payment_details: [
      { payment_form: '1', payment_method_code: PAYMENT_METHOD_CODE[order.payment_method ?? ''] ?? '10', amount: paid.toFixed(2) },
    ],
    ...(rounding.isZero() ? {} : { cash_rounding_amount: rounding.toFixed(2) }),
    customer: (order.invoice_customer as InvoiceCustomer | null) ?? FINAL_CONSUMER,
    items,
    ...(tip.isZero()
      ? {}
      : {
          allowance_charges: [
            { concept_type: '03', is_surcharge: true, reason: 'propina', base_amount: net.toFixed(2), amount: tip.toFixed(2) },
          ],
        }),
  };
  return body;
}
