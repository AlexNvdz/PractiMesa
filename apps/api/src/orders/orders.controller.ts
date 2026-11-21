import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { MAX_COP, num, oneOf, parseBody, uuid } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ItemInput, parseItems, priceItems, totals } from './order-items';

const ORDER_INCLUDE = {
  order_items: { orderBy: { round: 'asc' }, include: { products: { select: { name: true } } } },
  dining_tables: { select: { name: true } },
} satisfies Prisma.ordersInclude;

/** Open account: not paid and not cancelled. */
const OPEN = { payment_status: { not: 'PAID' }, status: { not: 'CANCELLED' } } satisfies Prisma.ordersWhereInput;

/** Voluntary tip (Ley 1935 de 2018): a suggested 5% or 10%, an amount the customer types, or none (omit both). */
const PAYMENT = {
  payment_method: oneOf('CASH', 'MANUAL_TRANSFER'),
  tip_percent: (v: unknown) => v === 5 || v === 10,
  tip_cop: num(0, MAX_COP),
};

/** Locks an open order of the location: 404 if it is not there, 409 if it is already paid or cancelled. */
async function lockOpenOrder(tx: Prisma.TransactionClient, id: string, locationId: string) {
  const [order] = await tx.$queryRaw<{ order_type: string; table_id: string | null; subtotal: string; open: boolean }[]>`
    SELECT order_type, table_id, subtotal_cop::text AS subtotal, (payment_status <> 'PAID' AND status <> 'CANCELLED') AS open
      FROM orders WHERE id = ${id}::uuid AND location_id = ${locationId}::uuid FOR UPDATE`;
  if (!order) throw new NotFoundException('Registro no encontrado');
  if (!order.open) throw new ConflictException('La cuenta ya está pagada o cancelada');
  return order;
}

async function addItems(tx: Prisma.TransactionClient, orderId: string, locationId: string, round: number, items: ItemInput[]) {
  const lines = await priceItems(tx, locationId, items);
  await tx.order_items.createMany({ data: lines.map((line) => ({ ...line, order_id: orderId, round })) });
  const sum = totals(lines);
  return tx.orders.update({
    where: { id: orderId },
    data: {
      subtotal_cop: { increment: sum.subtotal_cop },
      tax_cop: { increment: sum.tax_cop },
      total_cop: { increment: sum.total_cop },
    },
    include: ORDER_INCLUDE,
  });
}

/**
 * POS orders of the request location (x-location-id). DINE_IN = open account per table, sent to the
 * kitchen in rounds and paid when closed; PICKUP = counter order. Stock is deducted only when paid.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly prisma: PrismaService) {}

  /** Open accounts (not paid, not cancelled), newest first. */
  @Get()
  list(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma.forTenant(tenant.organizationId).orders.findMany({
      where: { location_id: requireLocation(tenant), ...OPEN },
      orderBy: { created_at: 'desc' },
      include: ORDER_INCLUDE,
    });
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = req.tenant!;
    const order = await this.prisma.forTenant(tenant.organizationId).orders.findFirst({
      where: { id, location_id: requireLocation(tenant) },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Registro no encontrado');
    return order;
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'CASHIER', 'WAITER')
  create(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const head = parseBody<{ order_type: string; table_id?: string }>(
      body,
      { order_type: oneOf('DINE_IN', 'PICKUP'), table_id: uuid },
      ['order_type'],
    );
    if ((head.order_type === 'DINE_IN') !== (head.table_id !== undefined)) {
      throw new BadRequestException('La mesa es obligatoria para consumo en el local y no aplica para llevar');
    }
    const items = parseItems(body);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      if (head.table_id) {
        // Table row lock: two waiters cannot open two accounts on the same table.
        const table = await tx.$queryRaw<unknown[]>`
          SELECT id FROM dining_tables WHERE id = ${head.table_id}::uuid AND location_id = ${locationId}::uuid FOR UPDATE`;
        if (!table.length) throw new BadRequestException('Mesa inválida');
        if (await tx.orders.count({ where: { table_id: head.table_id, ...OPEN } })) {
          throw new ConflictException('La mesa ya tiene una cuenta abierta');
        }
        await tx.dining_tables.update({ where: { id: head.table_id }, data: { status: 'OCCUPIED' } });
      }
      const order = await tx.orders.create({
        data: {
          location_id: locationId,
          table_id: head.table_id,
          channel: 'POS',
          order_type: head.order_type,
          status: 'CONFIRMED',
          subtotal_cop: 0,
          tax_cop: 0,
          total_cop: 0,
        },
      });
      return addItems(tx, order.id, locationId, 1, items);
    });
  }

  /** Adds a round (a new kitchen ticket) to an open account. */
  @Post(':id/items')
  @Roles('OWNER', 'ADMIN', 'CASHIER', 'WAITER')
  addRound(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const items = parseItems(body);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      await lockOpenOrder(tx, id, locationId);
      const last = await tx.order_items.aggregate({ _max: { round: true }, where: { order_id: id } });
      return addItems(tx, id, locationId, (last._max.round ?? 0) + 1, items);
    });
  }

  /**
   * Charges the order into the open register and deducts its recipes from the location stock
   * (stock may go negative). Returns the ingredients at or below their alert level.
   * The tip is charged on top of the total; a suggested percentage applies to the subtotal before tax.
   */
  @Post(':id/pay')
  @Roles('OWNER', 'ADMIN', 'CASHIER')
  pay(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    // FACTUS_PAY_QR arrives with the Factus Pay integration (2.7).
    const { payment_method, tip_percent, tip_cop } = parseBody<{ payment_method: string; tip_percent?: number; tip_cop?: number }>(
      body,
      PAYMENT,
      ['payment_method'],
    );
    if (tip_percent !== undefined && tip_cop !== undefined) throw new BadRequestException('Elige un porcentaje o un valor de propina, no ambos');
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const order = await lockOpenOrder(tx, id, locationId);
      const tip = tip_percent
        ? new Prisma.Decimal(order.subtotal).times(tip_percent).dividedBy(100).toDecimalPlaces(0)
        : new Prisma.Decimal(tip_cop ?? 0);
      // FOR SHARE: a register close (FOR UPDATE) waits for this sale, or this sale sees the register closed.
      const [register] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM cash_registers WHERE location_id = ${locationId}::uuid AND status = 'OPEN' FOR SHARE`;
      if (!register) throw new ConflictException('Abre la caja antes de cobrar');

      const stock_alerts = await tx.$queryRaw<{ ingredient_id: string; name: string; unit: string; current_qty: string; min_alert_qty: string }[]>`
        WITH used AS (
          INSERT INTO location_stock (location_id, ingredient_id, current_qty)
          SELECT ${locationId}::uuid, r.ingredient_id, -SUM(r.quantity_required * i.quantity)
            FROM order_items i JOIN product_recipes r ON r.product_id = i.product_id
           WHERE i.order_id = ${id}::uuid
           GROUP BY r.ingredient_id
          ON CONFLICT (location_id, ingredient_id)
          DO UPDATE SET current_qty = location_stock.current_qty + EXCLUDED.current_qty
          RETURNING ingredient_id, current_qty, min_alert_qty
        )
        SELECT u.ingredient_id, g.name, g.unit, u.current_qty::text AS current_qty, u.min_alert_qty::text AS min_alert_qty
          FROM used u JOIN ingredients g ON g.id = u.ingredient_id
         WHERE u.current_qty <= u.min_alert_qty
         ORDER BY g.name`;

      if (order.table_id) await tx.dining_tables.update({ where: { id: order.table_id }, data: { status: 'FREE' } });
      const paid = await tx.orders.update({
        where: { id },
        data: {
          payment_method,
          payment_status: 'PAID',
          tip_cop: tip,
          cash_register_id: register.id,
          // Paying closes a table account; a counter order stays in the kitchen flow until delivered.
          ...(order.order_type === 'DINE_IN' ? { status: 'COMPLETED' } : {}),
        },
        include: ORDER_INCLUDE,
      });
      return { ...paid, stock_alerts };
    });
  }

  /** Cancels an unpaid order (no stock is deducted) and frees its table. */
  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'CASHIER')
  cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const order = await lockOpenOrder(tx, id, locationId);
      if (order.table_id) await tx.dining_tables.update({ where: { id: order.table_id }, data: { status: 'FREE' } });
      return tx.orders.update({ where: { id }, data: { status: 'CANCELLED' }, include: ORDER_INCLUDE });
    });
  }
}
