import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { MAX_COP, num, parseBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Cash registers of the request location (x-location-id). At most one is OPEN per location. */
@Controller('cash-registers')
@Roles('OWNER', 'ADMIN', 'CASHIER')
export class CashRegistersController {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first, so the open register (if any) is always the first item. */
  @Get()
  list(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma.forTenant(tenant.organizationId).cash_registers.findMany({
      where: { location_id: requireLocation(tenant) },
      orderBy: { opened_at: 'desc' },
      take: 30,
      include: { users: { select: { full_name: true } } },
    });
  }

  @Post()
  open(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const data = parseBody<{ opening_amount_cop: number }>(body, { opening_amount_cop: num(0, MAX_COP) }, ['opening_amount_cop']);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      // Lock the location row so two concurrent opens are checked one after the other.
      await tx.$queryRaw`SELECT id FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`;
      if (await tx.cash_registers.count({ where: { location_id: locationId, status: 'OPEN' } })) {
        throw new ConflictException('Ya hay una caja abierta en esta sede');
      }
      return tx.cash_registers.create({ data: { ...data, location_id: locationId, opened_by: tenant.userId } });
    });
  }

  /** Cash count: expected = opening amount + cash sales paid into this register; the cashier enters the actual amount. */
  @Post(':id/close')
  close(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const data = parseBody<{ actual_closing_cop: number }>(body, { actual_closing_cop: num(0, MAX_COP) }, ['actual_closing_cop']);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      // Row lock: a concurrent close (or a sale paid into this register) waits until the count is stored.
      const [register] = await tx.$queryRaw<{ status: string; opening: string }[]>`
        SELECT status, opening_amount_cop::text AS opening FROM cash_registers
         WHERE id = ${id}::uuid AND location_id = ${locationId}::uuid FOR UPDATE`;
      if (!register) throw new NotFoundException('Registro no encontrado');
      if (register.status !== 'OPEN') throw new ConflictException('La caja ya está cerrada');
      const cash = await tx.orders.aggregate({
        _sum: { total_cop: true },
        where: { cash_register_id: id, payment_method: 'CASH', payment_status: 'PAID' },
      });
      return tx.cash_registers.update({
        where: { id },
        data: {
          ...data,
          status: 'CLOSED',
          closed_at: new Date(),
          expected_closing_cop: new Prisma.Decimal(register.opening).plus(cash._sum.total_cop ?? 0),
        },
      });
    });
  }
}
