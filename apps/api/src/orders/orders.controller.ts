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
import { MAX_COP, num, oneOf, parseBody, text, uuid } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { InvoicingService } from '../invoicing/invoicing.service';
import { FactusPayService } from '../payments/factus-pay.service';
import { PrismaService } from '../prisma/prisma.service';
import { ItemInput, parseItems, priceItems, totals } from './order-items';
import { LockedOrder, lockOpenOrder, ORDER_INCLUDE, settleOrder } from './settle';

/** Open account: not paid and not cancelled. */
const OPEN = { payment_status: { not: 'PAID' }, status: { not: 'CANCELLED' } } satisfies Prisma.ordersWhereInput;

/** Voluntary tip (Ley 1935 de 2018): a suggested 5% or 10%, an amount the customer types, or none (omit both). */
const PAYMENT = {
  payment_method: oneOf('CASH', 'MANUAL_TRANSFER', 'FACTUS_PAY_QR'),
  tip_percent: (v: unknown) => v === 5 || v === 10,
  tip_cop: num(0, MAX_COP),
};

/** Factus Pay limits per collection (the API rejects less than 10.000, docs say 1.000), and QR validity in seconds. */
const QR_MIN_COP = 10_000;
const QR_MAX_COP = 12_100_000;
const QR_SECONDS = 1800;

/** Why a line was voided or an order cancelled (Q61); OTHER needs a short note. */
const VOID = { reason: oneOf('MISTAKE', 'NOT_WANTED', 'DELAY', 'OTHER'), note: text(120) };

/** Reason of a void or a cancel; any role allowed to do it does it directly, under its own name. */
function voidReason(body: unknown) {
  const data = parseBody<{ reason: string; note?: string }>(body, VOID, ['reason']);
  if (data.reason === 'OTHER' && !data.note) throw new BadRequestException('Escribe el motivo');
  return { reason: data.reason, note: data.reason === 'OTHER' ? data.note! : null };
}

/** Locks an open account that can still change: a pending QR was issued for its exact amount. */
async function lockEditableOrder(tx: Prisma.TransactionClient, id: string, locationId: string) {
  const order = await lockOpenOrder(tx, id, locationId);
  if (order.payment_status === 'PENDING_QR') {
    throw new ConflictException('La cuenta tiene un QR de pago pendiente: cóbrala por otro medio o espera el pago');
  }
  return order;
}

async function addItems(tx: Prisma.TransactionClient, orderId: string, locationId: string, round: number, items: ItemInput[]) {
  const lines = await priceItems(tx, locationId, items);
  await tx.order_rounds.create({ data: { order_id: orderId, round } });
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly factusPay: FactusPayService,
    private readonly invoicing: InvoicingService,
  ) {}

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
      await lockEditableOrder(tx, id, locationId);
      // From the rounds, not the items: a round whose lines were all voided keeps its number.
      const last = await tx.order_rounds.aggregate({ _max: { round: true }, where: { order_id: id } });
      return addItems(tx, id, locationId, (last._max.round ?? 0) + 1, items);
    });
  }

  /**
   * Charges the order. Cash and transfer settle now, into the open register. FACTUS_PAY_QR returns a QR for
   * total + tip and leaves the order PENDING_QR until the Factus Pay webhook confirms it. The tip is charged
   * on top of the total; a suggested percentage applies to the subtotal before tax.
   */
  @Post(':id/pay')
  @Roles('OWNER', 'ADMIN', 'CASHIER')
  async pay(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const { payment_method, tip_percent, tip_cop } = parseBody<{ payment_method: string; tip_percent?: number; tip_cop?: number }>(
      body,
      PAYMENT,
      ['payment_method'],
    );
    if (tip_percent !== undefined && tip_cop !== undefined) throw new BadRequestException('Elige un porcentaje o un valor de propina, no ambos');
    const tipFor = (order: LockedOrder) =>
      tip_percent
        ? new Prisma.Decimal(order.subtotal).times(tip_percent).dividedBy(100).toDecimalPlaces(0)
        : new Prisma.Decimal(tip_cop ?? 0);
    if (payment_method === 'FACTUS_PAY_QR') return this.requestQr(tenant.organizationId, id, locationId, tipFor);

    const paid = await this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const order = await lockOpenOrder(tx, id, locationId);
      // FOR SHARE: a register close (FOR UPDATE) waits for this sale, or this sale sees the register closed.
      const [register] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM cash_registers WHERE location_id = ${locationId}::uuid AND status = 'OPEN' FOR SHARE`;
      if (!register) throw new ConflictException('Abre la caja antes de cobrar');
      return settleOrder(tx, id, locationId, order, { payment_method, tip_cop: tipFor(order), cash_register_id: register.id });
    });
    // An invoice asked for before paying goes out now, after the commit; the job only retries failures.
    if (paid.factus_status === 'PENDING') void this.invoicing.emit(id);
    return paid;
  }

  /**
   * QR of the business's Factus Pay account for total + tip. Asking again returns the same QR: Factus Pay
   * keys it by reference (the order id) and accepts only that exact amount, so the tip is fixed once issued.
   */
  private async requestQr(organizationId: string, id: string, locationId: string, tipFor: (order: LockedOrder) => Prisma.Decimal) {
    const account = await this.factusPay.accountFor(organizationId);
    const amount = await this.prisma.tenantTransaction(organizationId, async (tx) => {
      const order = await lockOpenOrder(tx, id, locationId);
      if (order.payment_status === 'PENDING_QR') return Number(order.due);
      if (!(await tx.cash_registers.count({ where: { location_id: locationId, status: 'OPEN' } }))) {
        throw new ConflictException('Abre la caja antes de cobrar');
      }
      const tip = tipFor(order);
      const due = new Prisma.Decimal(order.due).minus(order.tip).plus(tip);
      if (due.lessThan(QR_MIN_COP) || due.greaterThan(QR_MAX_COP)) {
        throw new BadRequestException('Factus Pay cobra entre $10.000 y $12.100.000');
      }
      await tx.orders.update({
        where: { id },
        data: { payment_method: 'FACTUS_PAY_QR', payment_status: 'PENDING_QR', tip_cop: tip, factus_payment_ref: id },
      });
      return due.toNumber();
    });
    const collection = await this.factusPay.createCollection(account, id, amount, QR_SECONDS);
    return this.prisma
      .forTenant(organizationId)
      .orders.update({ where: { id }, data: { factus_qr_payload: collection.qr }, include: ORDER_INCLUDE });
  }

  /**
   * Voids a line of an open account (a mistake, a dish the table no longer wants). The line stays, marked with
   * who voided it, when and why; totals drop by what it added and the kitchen sees it crossed out.
   */
  @Post(':id/items/:itemId/void')
  @Roles('OWNER', 'ADMIN', 'CASHIER', 'WAITER')
  async voidItem(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const why = voidReason(body);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      await lockEditableOrder(tx, id, locationId);
      const item = await tx.order_items.findFirst({ where: { id: itemId, order_id: id } });
      if (!item) throw new NotFoundException('Registro no encontrado');
      if (item.voided_at) throw new ConflictException('Esa línea ya está anulada');
      await tx.order_items.update({
        where: { id: itemId },
        data: {
          voided_at: new Date(),
          voided_by: tenant.userId,
          void_reason: why.reason,
          void_note: why.note,
        },
      });
      const sum = totals([item]);
      return tx.orders.update({
        where: { id },
        data: {
          subtotal_cop: { decrement: sum.subtotal_cop },
          tax_cop: { decrement: sum.tax_cop },
          total_cop: { decrement: sum.total_cop },
        },
        include: ORDER_INCLUDE,
      });
    });
  }

  /** Cancels an unpaid order (no stock is deducted) and frees its table; who, when and why are kept. */
  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'CASHIER', 'WAITER')
  async cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const why = voidReason(body);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const order = await lockOpenOrder(tx, id, locationId);
      if (order.table_id) await tx.dining_tables.update({ where: { id: order.table_id }, data: { status: 'FREE' } });
      return tx.orders.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelled_at: new Date(),
          cancelled_by: tenant.userId,
          cancel_reason: why.reason,
          cancel_note: why.note,
        },
        include: ORDER_INCLUDE,
      });
    });
  }
}
