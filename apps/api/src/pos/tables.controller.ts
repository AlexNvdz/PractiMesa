import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { int, nullable, oneOf, parseBody, text, uuid } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

/** number and name are unique per location; floor_id must be a floor of the same location (FK). */
const TABLE = { name: text(40), number: int(1, 9999), capacity: int(1, 99), floor_id: nullable(uuid) };
type TableInput = { name?: string; number?: number; capacity?: number; floor_id?: string | null };
const STATUS = { status: oneOf('FREE', 'OCCUPIED', 'RESERVED') };

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
      // Lock the location row so concurrent creates do not pick the same next number.
      await tx.$queryRaw`SELECT id FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`;
      const last = await tx.dining_tables.aggregate({ _max: { number: true }, where: { location_id: locationId } });
      const number = data.number ?? (last._max.number ?? 0) + 1;
      return tx.dining_tables.create({ data: { ...data, number, name: data.name ?? `Mesa #${number}`, location_id: locationId } });
    });
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<TableInput>(body, TABLE);
    return this.prisma
      .forTenant(tenant.organizationId)
      .dining_tables.update({ where: { id, location_id: requireLocation(tenant) }, data });
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
