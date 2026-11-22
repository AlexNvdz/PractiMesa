import { BadRequestException } from '@nestjs/common';
import { int, nullable, parseBody, text, uuid } from '../common/validation';
import { Prisma } from '../generated/prisma/client';

export interface ModifierPick {
  group: string;
  option: string;
}
export interface ItemInput {
  product_id: string;
  quantity: number;
  modifiers: ModifierPick[];
  notes?: string | null;
}
interface ModifierGroup {
  name: string;
  required: boolean;
  multiple: boolean;
  options: { name: string; price_cop: number }[];
}

const ITEMS = { items: (v: unknown) => Array.isArray(v) && v.length >= 1 && v.length <= 50 };
const ITEM = {
  product_id: uuid,
  quantity: int(1, 99),
  modifiers: (v: unknown) => Array.isArray(v) && v.length <= 30,
  notes: nullable(text(200)),
};
const PICK = { group: text(60), option: text(60) };

/** Body `items`: 1..50 lines, each one (and each picked modifier) whitelisted like any other body. */
export function parseItems(body: unknown): ItemInput[] {
  const { items } = parseBody<{ items: unknown[] }>(body, ITEMS, ['items']);
  return items.map((item) => {
    const line = parseBody<Omit<ItemInput, 'modifiers'> & { modifiers?: unknown[] }>(item, ITEM, ['product_id', 'quantity']);
    return { ...line, modifiers: (line.modifiers ?? []).map((m) => parseBody<ModifierPick>(m, PICK, ['group', 'option'])) };
  });
}

/** Checks the picks against the product modifiers_schema and returns them with their price. */
export function pickModifiers(schema: ModifierGroup[], picks: ModifierPick[]) {
  const picked = picks.map(({ group, option }) => {
    const found = schema.find((g) => g.name === group)?.options.find((o) => o.name === option);
    if (!found) throw new BadRequestException(`Modificador inválido: ${group} / ${option}`);
    return { group, option, price_cop: found.price_cop };
  });
  if (new Set(picked.map((p) => `${p.group}/${p.option}`)).size !== picked.length) {
    throw new BadRequestException('Modificador repetido');
  }
  for (const g of schema) {
    const count = picked.filter((p) => p.group === g.name).length;
    if (g.required && count === 0) throw new BadRequestException(`Falta elegir: ${g.name}`);
    if (!g.multiple && count > 1) throw new BadRequestException(`Elige solo una opción en: ${g.name}`);
  }
  return picked;
}

/**
 * Order item rows priced for the location: custom price or base price, plus the picked modifiers.
 * The tax rate is copied so later product changes do not alter the account or its invoice.
 */
export async function priceItems(tx: Prisma.TransactionClient, locationId: string, items: ItemInput[]) {
  const products = await tx.products.findMany({
    // Chain products and this location's own ones (Q43); another location's own product is not sold here.
    where: { id: { in: items.map((i) => i.product_id) }, is_active: true, OR: [{ location_id: null }, { location_id: locationId }] },
    include: { location_products: { where: { location_id: locationId } } },
  });
  return items.map((item) => {
    const product = products.find((p) => p.id === item.product_id);
    const local = product?.location_products[0];
    if (!product || local?.is_available === false || local?.is_listed === false) throw new BadRequestException('Producto no disponible en esta sede');
    const modifiers = pickModifiers(product.modifiers_schema as unknown as ModifierGroup[], item.modifiers);
    const base = new Prisma.Decimal(local?.custom_price_cop ?? product.base_price_cop);
    return {
      product_id: product.id,
      quantity: item.quantity,
      notes: item.notes ?? null,
      selected_modifiers: modifiers,
      unit_price_cop: modifiers.reduce((sum, m) => sum.plus(m.price_cop), base),
      tax_rate: product.tax_rate,
    };
  });
}

/** Consumer prices in Colombia include tax, so the tax is extracted: line - line / (1 + rate). */
export function totals(lines: { quantity: number; unit_price_cop: Prisma.Decimal; tax_rate: Prisma.Decimal }[]) {
  let total = new Prisma.Decimal(0);
  let tax = new Prisma.Decimal(0);
  for (const l of lines) {
    const line = l.unit_price_cop.times(l.quantity);
    total = total.plus(line);
    tax = tax.plus(line.minus(line.dividedBy(l.tax_rate.dividedBy(100).plus(1))).toDecimalPlaces(2));
  }
  return { total_cop: total, tax_cop: tax, subtotal_cop: total.minus(tax) };
}
