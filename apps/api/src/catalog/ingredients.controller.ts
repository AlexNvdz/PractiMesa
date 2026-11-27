import { Body, ConflictException, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { parseBody, text } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** unit is free text ('gr', 'ml', 'und'...); recipes and stock use the same unit. */
const INGREDIENT = { name: text(120), unit: text(20) };

/** Names are unique per business ignoring case (no DB index: older data may already repeat them). */
async function assertNameFree(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
  const taken = await tx.ingredients.findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) },
    select: { id: true },
  });
  if (taken) throw new ConflictException(`Ya existe un ingrediente llamado "${name.trim()}"`);
}

/** Inventory ingredients (organization-wide). Deleting one removes it from recipes and stock. */
@Controller('ingredients')
export class IngredientsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * here=1: only what the request location works with (Q43). Hides ingredients that only other locations use:
   * in some recipe, none of those products sold here, and no stock here. Unused ingredients stay visible.
   */
  @Get()
  list(@Req() req: Request, @Query('here') here?: string) {
    const tenant = req.tenant!;
    const db = this.prisma.forTenant(tenant.organizationId);
    if (here !== '1') return db.ingredients.findMany({ orderBy: { name: 'asc' } });
    const locationId = requireLocation(tenant);
    const soldHere = {
      OR: [{ location_id: null }, { location_id: locationId }],
      location_products: { none: { location_id: locationId, is_listed: false } },
    };
    return db.ingredients.findMany({
      where: {
        OR: [
          { location_stock: { some: { location_id: locationId } } },
          { product_recipes: { none: {} } },
          { product_recipes: { some: { products: soldHere } } },
        ],
      },
      orderBy: { name: 'asc' },
    });
  }

  @Post()
  @Roles('OWNER')
  create(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody<Prisma.ingredientsUncheckedCreateInput>(body, INGREDIENT, ['name', 'unit']);
    return this.prisma.tenantTransaction(req.tenant!.organizationId, async (tx) => {
      await assertNameFree(tx, data.name);
      return tx.ingredients.create({ data });
    });
  }

  @Patch(':id')
  @Roles('OWNER')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.ingredientsUncheckedUpdateInput>(body, INGREDIENT);
    return this.prisma.tenantTransaction(req.tenant!.organizationId, async (tx) => {
      if (typeof data.name === 'string') await assertNameFree(tx, data.name, id);
      return tx.ingredients.update({ where: { id }, data });
    });
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.forTenant(req.tenant!.organizationId).ingredients.delete({ where: { id } });
  }
}
