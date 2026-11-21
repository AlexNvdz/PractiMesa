import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { int, nullable, oneOf, parseBody, text, uuid } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** number and name are unique per location; floor_id must be a floor of the same location (FK). */
const TABLE = { name: text(40), number: int(1, 9999), capacity: int(1, 99), floor_id: nullable(uuid) };
type TableInput = { name?: string; number?: number; capacity?: number; floor_id?: string | null };
const STATUS = { status: oneOf('FREE', 'OCCUPIED', 'RESERVED') };
const BATCH = { count: int(1, 50), capacity: TABLE.capacity, floor_id: TABLE.floor_id };

/** Next free number of the location. Locks the location row so concurrent creates do not pick the same one. */
async function nextNumber(tx: Prisma.TransactionClient, locationId: string) {
  await tx.$queryRaw`SELECT id FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`;
  const last = await tx.dining_tables.aggregate({ _max: { number: true }, where: { location_id: locationId } });
  return (last._max.number ?? 0) + 1;
}

/** Dining tables of the request location (x-location-id); every write is scoped to that location too. */
@Controller('tables')
export class TablesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma
      .forTenant(tenant.organizationId)
      .dining_tables.findMany({ where: { location_id: requireLocation(tenant) }, orderBy: { number: 'asc' } });
  }

  /** Without number: the next one of the location. Without name: "Mesa #<number>". */
  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const data = parseBody<TableInput>(body, TABLE);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const number = data.number ?? (await nextNumber(tx, locationId));
      return tx.dining_tables.create({ data: { ...data, number, name: data.name ?? `Mesa #${number}`, location_id: locationId } });
    });
  }

  /** Sets up a floor in one go: `count` tables "Mesa #n" numbered after the last one of the location. All or none. */
  @Post('batch')
  @Roles('OWNER', 'ADMIN')
  createBatch(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const { count, ...data } = parseBody<{ count: number; capacity?: number; floor_id?: string | null }>(body, BATCH, ['count']);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const first = await nextNumber(tx, locationId);
      const numbers = Array.from({ length: count }, (_, i) => first + i);
      return tx.dining_tables.createManyAndReturn({
        data: numbers.map((number) => ({ ...data, number, name: `Mesa #${number}`, location_id: locationId })),
      });
    });
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const where = { id, location_id: requireLocation(tenant) };
    const data = parseBody<TableInput>(body, TABLE);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      if (data.number !== undefined && data.name === undefined) {
        const current = await tx.dining_tables.findFirst({ where, select: { name: true, number: true } });
        // A default name follows the new number; a custom one ("Barra") stays.
        if (current?.name === `Mesa #${current?.number}`) data.name = `Mesa #${data.number}`;
      }
      return tx.dining_tables.update({ where, data });
    });
  }

  /** Floor staff mark tables reserved or free; open accounts (2.6) will set OCCUPIED themselves. */
  @Put(':id/status')
  @Roles('OWNER', 'ADMIN', 'CASHIER', 'WAITER')
  setStatus(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<{ status: string }>(body, STATUS, ['status']);
    return this.prisma
      .forTenant(tenant.organizationId)
      .dining_tables.update({ where: { id, location_id: requireLocation(tenant) }, data });
  }

  /** A table with orders or reservations cannot be deleted (FK, answered as 409). */
  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = req.tenant!;
    await this.prisma
      .forTenant(tenant.organizationId)
      .dining_tables.delete({ where: { id, location_id: requireLocation(tenant) } });
  }
}
