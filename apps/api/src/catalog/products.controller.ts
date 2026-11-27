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
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { ACCENTS_FROM, ACCENTS_TO, likePattern, nextOffset, pageParams } from '../common/paging';
import { requireLocation } from '../common/tenant/tenant-context';
import { bool, MAX_COP, MAX_QTY, modifiersSchema, nullable, num, parseBody, text, url, uuid } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
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

  /**
   * Catalog screen, one page at a time: the chain's products plus this location's own (Q43), in category order,
   * each with this location's price and availability (`local`). `category` is a category id or "none"; `q`
   * ignores case and accents. `counts` is per category over everything visible, so the chips stay whole.
   */
  @Get('page')
  async page(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const tenant = req.tenant!;
    const loc = requireLocation(tenant);
    if (category && category !== 'none' && !uuid(category)) throw new BadRequestException('category inválida');
    const { limit: size, offset: skip } = pageParams(limit, offset, 24);
    const pattern = q?.trim() ? likePattern(q) : '%';
    const inCategory = !category ? Prisma.sql`TRUE` : category === 'none' ? Prisma.sql`p.category_id IS NULL` : Prisma.sql`p.category_id = ${category}::uuid`;
    const db = this.prisma.forTenant(tenant.organizationId);
    const [ids, grouped] = await Promise.all([
      this.prisma.tenantTransaction(tenant.organizationId, (tx) =>
        tx.$queryRaw<{ id: string; total: number }[]>`
          SELECT p.id, count(*) OVER ()::int AS total
            FROM products p LEFT JOIN categories c ON c.id = p.category_id
           WHERE (p.location_id IS NULL OR p.location_id = ${loc}::uuid)
             AND ${inCategory}
             AND translate(lower(p.name), ${ACCENTS_FROM}, ${ACCENTS_TO}) LIKE ${pattern} ESCAPE '\\'
           ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, p.name, p.id
           LIMIT ${size} OFFSET ${skip}`,
      ),
      db.products.groupBy({ by: ['category_id'], where: { OR: [{ location_id: null }, { location_id: loc }] }, _count: { _all: true } }),
    ]);
    const rows = await db.products.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      include: { location_products: { where: { location_id: loc } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const counts: Record<string, number> = {};
    let all = 0;
    for (const g of grouped) {
      counts[g.category_id ?? 'none'] = g._count._all;
      all += g._count._all;
    }
    // An offset past the end has no rows to carry the total: it is what the counts say for this filter.
    const total = ids[0]?.total ?? (skip ? await this.pageTotal(tenant.organizationId, loc, inCategory, pattern) : 0);
    return {
      items: ids.map(({ id }) => {
        const { location_products, ...product } = byId.get(id)!;
        return { ...product, local: location_products[0] ?? null };
      }),
      total,
      next: nextOffset(skip, size, total),
      counts: { all, ...counts },
    };
  }

  private async pageTotal(organizationId: string, loc: string, inCategory: Prisma.Sql, pattern: string) {
    const [row] = await this.prisma.tenantTransaction(organizationId, (tx) =>
      tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM products p
         WHERE (p.location_id IS NULL OR p.location_id = ${loc}::uuid) AND ${inCategory}
           AND translate(lower(p.name), ${ACCENTS_FROM}, ${ACCENTS_TO}) LIKE ${pattern} ESCAPE '\\'`,
    );
    return row.total;
  }

  @Post()
  @Roles('OWNER')
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
  @Roles('OWNER')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.productsUncheckedUpdateInput>(body, PRODUCT);
    return this.prisma.forTenant(req.tenant!.organizationId).products.update({ where: { id }, data });
  }

  /** Products already sold cannot be deleted (409): deactivate them with is_active = false. */
  @Delete(':id')
  @Roles('OWNER')
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
  @Roles('OWNER')
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
