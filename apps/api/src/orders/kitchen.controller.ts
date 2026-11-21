import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { requireLocation } from '../common/tenant/tenant-context';
import { oneOf, parseBody } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Kitchen flow of a round, in order. A round moves forward and may skip steps (a drink goes straight to READY);
 * it moves back only to undo a tap, naming the step the screen saw (`from`).
 */
const STEPS = ['PENDING', 'PREPARING', 'READY', 'DELIVERED'] as const;
type Step = (typeof STEPS)[number];
const STAMP = { PREPARING: 'started_at', READY: 'ready_at', DELIVERED: 'delivered_at' } as const;
const STATE = { PENDING: 'pendiente', PREPARING: 'en preparación', READY: 'lista', DELIVERED: 'entregada' } as const;

/** Who serves the table only marks a round delivered (or undoes that); the kitchen and managers move every step. */
const SERVERS = new Set(['CASHIER', 'WAITER']);

const ROUND_INCLUDE = {
  orders: { select: { order_number: true, order_type: true, status: true, dining_tables: { select: { name: true } } } },
  order_items: { select: { id: true, quantity: true, selected_modifiers: true, notes: true, products: { select: { name: true } } } },
} satisfies Prisma.order_roundsInclude;

/**
 * Kitchen screen (KDS) of the request location: one ticket per round (comanda). A ticket stays until it is
 * delivered, also after the account is paid (a paid counter order is still cooking); a cancelled order leaves.
 * Changes reach every terminal over SSE as an `order` event (trigger in migration 0011).
 */
@Controller('kitchen')
export class KitchenController {
  constructor(private readonly prisma: PrismaService) {}

  /** Rounds still to serve, oldest first. A round whose lines were all voided has nothing to cook. */
  @Get('rounds')
  list(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma.forTenant(tenant.organizationId).order_rounds.findMany({
      where: {
        status: { in: ['PENDING', 'PREPARING', 'READY'] },
        order_items: { some: {} },
        orders: { location_id: requireLocation(tenant), status: { not: 'CANCELLED' } },
      },
      orderBy: { created_at: 'asc' },
      include: ROUND_INCLUDE,
    });
  }

  /**
   * Moves a round to a later step; repeating the current step is a no-op, so a double tap is harmless.
   * With `from` it moves only if the round is still at that step, in either direction (undo).
   */
  @Put('rounds/:id')
  advance(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const { status, from } = parseBody<{ status: Step; from?: Step }>(body, { status: oneOf(...STEPS), from: oneOf(...STEPS) }, ['status']);
    const target = STEPS.indexOf(status);
    const back = from !== undefined && STEPS.indexOf(from) > target;
    if (status === 'PENDING' && !back) throw new BadRequestException('Una comanda solo vuelve a pendiente al deshacer');
    if (SERVERS.has(tenant.role) && !(status === 'DELIVERED' || (status === 'READY' && from === 'DELIVERED'))) {
      throw new ForbiddenException('Tu rol solo puede marcar comandas como entregadas');
    }
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      // One conditional update: two terminals tapping at once cannot move a round backwards by accident.
      await tx.order_rounds.updateMany({
        where: {
          id,
          status: from ?? { in: STEPS.slice(0, target) },
          orders: { location_id: locationId, status: { not: 'CANCELLED' } },
        },
        data: {
          status,
          // Steps after the new one did not happen (undo); the new one happens now unless it is a step back.
          ...Object.fromEntries(STEPS.slice(target + 1).map((step) => [STAMP[step as keyof typeof STAMP], null])),
          ...(back ? {} : { [STAMP[status as keyof typeof STAMP]]: new Date() }),
        },
      });
      const round = await tx.order_rounds.findFirst({ where: { id, orders: { location_id: locationId } }, include: ROUND_INCLUDE });
      if (!round) throw new NotFoundException('Registro no encontrado');
      if (round.orders.status === 'CANCELLED') throw new ConflictException('El pedido fue anulado');
      if (round.status !== status) throw new ConflictException(`La comanda ya está ${STATE[round.status as Step]}`);
      return round;
    });
  }
}
