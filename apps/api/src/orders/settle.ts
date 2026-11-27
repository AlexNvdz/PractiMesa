import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

export const ORDER_INCLUDE = {
  order_items: {
    orderBy: { round: 'asc' },
    include: {
      products: { select: { name: true } },
      voider: { select: { full_name: true } },
    },
  },
  order_rounds: { orderBy: { round: 'asc' }, select: { id: true, round: true, status: true, created_at: true } },
  dining_tables: { select: { name: true } },
} satisfies Prisma.ordersInclude;

/** A round the kitchen or the floor still has to serve: not delivered, with a line that was not voided. */
export const TO_SERVE = { status: { not: 'DELIVERED' }, order_items: { some: { voided_at: null } } } satisfies Prisma.order_roundsWhereInput;

/** Orders the floor still deals with: open accounts, and paid ones whose food has not reached the table. */
export const IN_SERVICE = {
  status: { not: 'CANCELLED' },
  OR: [{ payment_status: { not: 'PAID' } }, { order_rounds: { some: TO_SERVE } }],
} satisfies Prisma.ordersWhereInput;

/** A table is occupied while any order on it is in service; paying before the food arrives keeps it taken. */
export async function syncTable(tx: Prisma.TransactionClient, tableId: string) {
  const busy = await tx.orders.count({ where: { table_id: tableId, ...IN_SERVICE } });
  await tx.dining_tables.update({ where: { id: tableId }, data: { status: busy ? 'OCCUPIED' : 'FREE', reserved_for: null } });
}

export interface LockedOrder {
  order_type: string;
  table_id: string | null;
  payment_status: string;
  subtotal: string;
  tip: string;
  /** total + tip: what the customer pays. */
  due: string;
  open: boolean;
}

/** Locks the order row of the location (FOR UPDATE); null if it is not there. */
export async function lockOrder(tx: Prisma.TransactionClient, id: string, locationId: string) {
  const [order] = await tx.$queryRaw<LockedOrder[]>`
    SELECT order_type, table_id, payment_status, subtotal_cop::text AS subtotal, tip_cop::text AS tip,
           (total_cop + tip_cop)::text AS due, (payment_status <> 'PAID' AND status <> 'CANCELLED') AS open
      FROM orders WHERE id = ${id}::uuid AND location_id = ${locationId}::uuid FOR UPDATE`;
  return order ?? null;
}

/** Locks an open order of the location: 404 if it is not there, 409 if it is already paid or cancelled. */
export async function lockOpenOrder(tx: Prisma.TransactionClient, id: string, locationId: string) {
  const order = await lockOrder(tx, id, locationId);
  if (!order) throw new NotFoundException('Registro no encontrado');
  if (!order.open) throw new ConflictException('La cuenta ya está pagada o cancelada');
  return order;
}

/**
 * Marks a locked order paid: deducts its recipes from the location stock (may go negative), frees its table
 * (once nothing is left to serve) and completes a table account (a counter order stays in the kitchen flow). Returns the order with the
 * ingredients left at or below their alert level.
 */
export async function settleOrder(
  tx: Prisma.TransactionClient,
  id: string,
  locationId: string,
  order: LockedOrder,
  payment: { payment_method: string; tip_cop: Prisma.Decimal | string; cash_register_id: string | null },
) {
  const stock_alerts = await tx.$queryRaw<{ ingredient_id: string; name: string; unit: string; current_qty: string; min_alert_qty: string }[]>`
    WITH used AS (
      INSERT INTO location_stock (location_id, ingredient_id, current_qty)
      SELECT ${locationId}::uuid, r.ingredient_id, -SUM(r.quantity_required * i.quantity)
        FROM order_items i JOIN product_recipes r ON r.product_id = i.product_id
       WHERE i.order_id = ${id}::uuid AND i.voided_at IS NULL
       GROUP BY r.ingredient_id
      ON CONFLICT (location_id, ingredient_id)
      DO UPDATE SET current_qty = location_stock.current_qty + EXCLUDED.current_qty
      RETURNING ingredient_id, current_qty, min_alert_qty
    )
    SELECT u.ingredient_id, g.name, g.unit, u.current_qty::text AS current_qty, u.min_alert_qty::text AS min_alert_qty
      FROM used u JOIN ingredients g ON g.id = u.ingredient_id
     WHERE u.current_qty <= u.min_alert_qty
     ORDER BY g.name`;

  const paid = await tx.orders.update({
    where: { id },
    data: { ...payment, payment_status: 'PAID', ...(order.order_type === 'DINE_IN' ? { status: 'COMPLETED' } : {}) },
    include: ORDER_INCLUDE,
  });
  if (order.table_id) await syncTable(tx, order.table_id);
  return { ...paid, stock_alerts };
}
