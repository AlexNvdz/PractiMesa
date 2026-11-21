import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { int, parseBody, text } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

const FLOOR = { name: text(40), sort_order: int(0, 10_000) };

/** Optional floors or zones of the request location ("Piso 2", "Terraza"); tables may sit on one. */
@Controller('floors')
export class FloorsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma.forTenant(tenant.organizationId).floors.findMany({
      where: { location_id: requireLocation(tenant) },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<{ name: string; sort_order?: number }>(body, FLOOR, ['name']);
    return this.prisma
      .forTenant(tenant.organizationId)
      .floors.create({ data: { ...data, location_id: requireLocation(tenant) } });
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<{ name?: string; sort_order?: number }>(body, FLOOR);
    return this.prisma
      .forTenant(tenant.organizationId)
      .floors.update({ where: { id, location_id: requireLocation(tenant) }, data });
  }

  /** A floor with tables cannot be deleted (FK, answered as 409): move or delete its tables first. */
  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = req.tenant!;
    await this.prisma
      .forTenant(tenant.organizationId)
      .floors.delete({ where: { id, location_id: requireLocation(tenant) } });
  }
}
