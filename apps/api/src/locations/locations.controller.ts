import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertLocationLimit, PlanGuard } from '../common/guards/plan.guard';
import { Roles } from '../common/guards/roles.guard';
import { bool, nullable, parseBody, text } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LOCATION = { name: text(120), city: text(80), address: text(300), phone_whatsapp: nullable(text(30)), is_active: bool };

/** Locations of the organization, inactive ones included (they still count toward the plan limit). */
@Controller('locations')
@Roles('OWNER')
export class LocationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    return this.prisma.forTenant(req.tenant!.organizationId).locations.findMany({ orderBy: { created_at: 'asc' } });
  }

  @Post()
  @UseGuards(PlanGuard)
  create(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody<Prisma.locationsUncheckedCreateInput>(body, LOCATION, ['name', 'city', 'address']);
    return this.prisma.tenantTransaction(req.tenant!.organizationId, async (tx) => {
      // PlanGuard counted outside any lock; lock the organization row so concurrent creates count one by one.
      const [org] = await tx.$queryRaw<{ plan_tier: string; max_locations: number }[]>`
        SELECT plan_tier, max_locations FROM organizations WHERE id = app_org_id() FOR UPDATE`;
      assertLocationLimit(org.plan_tier, org.max_locations, await tx.locations.count());
      return tx.locations.create({ data });
    });
  }

  /** Never deactivates the last active location: without one nobody could work in the panel. */
  @Patch(':id')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.locationsUncheckedUpdateInput>(body, LOCATION);
    return this.prisma.tenantTransaction(req.tenant!.organizationId, async (tx) => {
      if (data.is_active === false) {
        // Organization row lock: two concurrent deactivations cannot both see the other location active.
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = app_org_id() FOR UPDATE`;
        if (!(await tx.locations.count({ where: { is_active: true, id: { not: id } } }))) {
          throw new ConflictException('Debe quedar al menos una sede activa');
        }
      }
      return tx.locations.update({ where: { id }, data });
    });
  }

  /** Orders and cash registers cascade with the location, so a location with history can only be deactivated. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.tenantTransaction(req.tenant!.organizationId, async (tx) => {
      // Row lock: orders insert updates locations.last_order_number, so none can slip in until we commit.
      const locked = await tx.$queryRaw<unknown[]>`SELECT id FROM locations WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Registro no encontrado');
      const history =
        (await tx.orders.count({ where: { location_id: id } })) + (await tx.cash_registers.count({ where: { location_id: id } }));
      if (history) throw new ConflictException('La sede tiene ventas o cajas registradas: desactívala en lugar de eliminarla');
      if ((await tx.locations.count()) === 1) throw new ConflictException('La organización debe tener al menos una sede');
      await tx.locations.delete({ where: { id } });
    });
  }
}
