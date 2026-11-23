import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { parseBody, text } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** unit is free text ('gr', 'ml', 'und'...); recipes and stock use the same unit. */
const INGREDIENT = { name: text(120), unit: text(20) };

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
    return this.prisma.forTenant(req.tenant!.organizationId).ingredients.create({ data });
  }

  @Patch(':id')
  @Roles('OWNER')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.ingredientsUncheckedUpdateInput>(body, INGREDIENT);
    return this.prisma.forTenant(req.tenant!.organizationId).ingredients.update({ where: { id }, data });
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.forTenant(req.tenant!.organizationId).ingredients.delete({ where: { id } });
  }
}
