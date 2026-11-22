import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { bool, MAX_COP, MAX_QTY, modifiersSchema, nullable, num, parseBody, text, url, uuid } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PRODUCT = {
  category_id: nullable(uuid),
  name: text(150),
  description: nullable(text(2000)),
  base_price_cop: num(0, MAX_COP),
  tax_rate: num(0, 100),
  dian_standard_code: nullable(text(30)),
  image_url: nullable(url),
  modifiers_schema: modifiersSchema,
  is_active: bool,
};
const RECIPE_ITEM = { ingredient_id: uuid, quantity_required: num(0.001, MAX_QTY) };
const WITH_INGREDIENT = { ingredients: { select: { name: true, unit: true } } } as const;

/**
 * Master catalog (organization-wide). Per-location price and availability live in location_products.
 * A product created with only_here belongs to the request location only (Q43).
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    return this.prisma.forTenant(req.tenant!.organizationId).products.findMany({ orderBy: { name: 'asc' } });
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const { only_here, ...data } = parseBody<Prisma.productsUncheckedCreateInput & { only_here?: boolean }>(
      body,
      { ...PRODUCT, only_here: bool },
      ['name', 'base_price_cop'],
    );
    // The location comes from the request (x-location-id, already checked), never from the body.
    if (only_here) data.location_id = requireLocation(tenant);
    return this.prisma.forTenant(tenant.organizationId).products.create({ data });
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.productsUncheckedUpdateInput>(body, PRODUCT);
    return this.prisma.forTenant(req.tenant!.organizationId).products.update({ where: { id }, data });
  }

  /** Products already sold cannot be deleted (409): deactivate them with is_active = false. */
  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.forTenant(req.tenant!.organizationId).products.delete({ where: { id } });
  }

  /** Ingredients consumed per unit sold. */
  @Get(':id/recipe')
  recipe(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.prisma
      .forTenant(req.tenant!.organizationId)
      .product_recipes.findMany({ where: { product_id: id }, include: WITH_INGREDIENT });
  }

  /** Replaces the whole recipe: body = [{ ingredient_id, quantity_required }]. */
  @Put(':id/recipe')
  @Roles('OWNER', 'ADMIN')
  setRecipe(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    if (!Array.isArray(body) || body.length > 100) throw new BadRequestException('La receta debe ser una lista de ingredientes');
    const items = body.map((item) =>
      parseBody<Omit<Prisma.product_recipesUncheckedCreateInput, 'product_id'>>(item, RECIPE_ITEM, [
        'ingredient_id',
        'quantity_required',
      ]),
    );
    return this.prisma.tenantTransaction(req.tenant!.organizationId, async (tx) => {
      await tx.products.findUniqueOrThrow({ where: { id }, select: { id: true } });
      await tx.product_recipes.deleteMany({ where: { product_id: id } });
      await tx.product_recipes.createMany({ data: items.map((item) => ({ ...item, product_id: id })) });
      return tx.product_recipes.findMany({ where: { product_id: id }, include: WITH_INGREDIENT });
    });
  }
}
