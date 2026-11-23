import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { logActivity } from '../activity/activity.controller';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { bool, MAX_COP, MAX_QTY, nullable, num, parseBody } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** null custom price = use the product base price. is_listed = false: this location never sells it (Q43). */
const LOCATION_PRODUCT = { custom_price_cop: nullable(num(0, MAX_COP)), is_available: bool, is_listed: bool };
/** Stock may go negative (sales are never blocked by inventory), so current_qty accepts negatives. */
const LOCATION_STOCK = { current_qty: num(-MAX_QTY, MAX_QTY), min_alert_qty: num(0, MAX_QTY) };
/** Goods received: a positive amount added to the stock. */
const RECEIVE = { qty: num(0.001, MAX_QTY) };
/** Name and unit go into the activity log, so an entry still reads well after the ingredient is deleted. */
const NAMED = { ingredients: { select: { name: true, unit: true } } } as const;

/**
 * Per-location overrides of the organization catalog and per-location stock.
 * The location is the request one (x-location-id), already checked against the user's locations.
 */
@Controller()
export class LocationCatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('location-products')
  products(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma
      .forTenant(tenant.organizationId)
      .location_products.findMany({ where: { location_id: requireLocation(tenant) } });
  }

  /** Price and "sold here" are the owner's (Q53); a supervisor only marks a product sold out today. */
  @Put('location-products/:productId')
  @Roles('OWNER', 'ADMIN')
  setProduct(@Req() req: Request, @Param('productId', ParseUUIDPipe) productId: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const key = { location_id: requireLocation(tenant), product_id: productId };
    const data = parseBody<{ custom_price_cop?: number | null; is_available?: boolean; is_listed?: boolean }>(body, LOCATION_PRODUCT);
    if (tenant.role !== 'OWNER' && (data.custom_price_cop !== undefined || data.is_listed !== undefined)) {
      throw new ForbiddenException('Solo el dueño cambia precios y lo que se vende en cada sede');
    }
    return this.prisma
      .forTenant(tenant.organizationId)
      .location_products.upsert({ where: { location_id_product_id: key }, create: { ...key, ...data }, update: data });
  }

  @Get('location-stock')
  stock(@Req() req: Request) {
    const tenant = req.tenant!;
    return this.prisma.forTenant(tenant.organizationId).location_stock.findMany({
      where: { location_id: requireLocation(tenant) },
      include: { ingredients: { select: { name: true, unit: true } } },
    });
  }

  /**
   * A stock count (sets the number). Cashiers too: they receive goods and count at opening (Q39). A count is
   * logged with the number it replaced (Q57); changing only the alert minimum is not.
   */
  @Put('location-stock/:ingredientId')
  @Roles('OWNER', 'ADMIN', 'CASHIER')
  setStock(@Req() req: Request, @Param('ingredientId', ParseUUIDPipe) ingredientId: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const key = { location_id: requireLocation(tenant), ingredient_id: ingredientId };
    const data = parseBody<{ current_qty?: number; min_alert_qty?: number }>(body, LOCATION_STOCK);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      // Row lock: a sale paid meanwhile cannot slip between the "before" we log and the count we store.
      const [row] = await tx.$queryRaw<{ qty: string }[]>`
        SELECT current_qty::text AS qty FROM location_stock
         WHERE location_id = ${key.location_id}::uuid AND ingredient_id = ${ingredientId}::uuid FOR UPDATE`;
      const saved = await tx.location_stock.upsert({
        where: { location_id_ingredient_id: key },
        create: { ...key, ...data },
        update: data,
        include: NAMED,
      });
      if (data.current_qty !== undefined) {
        const { name, unit } = saved.ingredients;
        const before = new Prisma.Decimal(row?.qty ?? 0).toString();
        await logActivity(tx, tenant, key.location_id, 'STOCK_COUNT', { ingredient: name, unit, before, after: saved.current_qty.toString() }, ingredientId);
      }
      return saved;
    });
  }

  /** Goods received: adds in one statement, so it never overwrites what a sale deducted meanwhile (Q40). */
  @Post('location-stock/:ingredientId/receive')
  @Roles('OWNER', 'ADMIN', 'CASHIER')
  @HttpCode(200)
  receive(@Req() req: Request, @Param('ingredientId', ParseUUIDPipe) ingredientId: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const key = { location_id: requireLocation(tenant), ingredient_id: ingredientId };
    const { qty } = parseBody<{ qty: number }>(body, RECEIVE, ['qty']);
    return this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      const saved = await tx.location_stock.upsert({
        where: { location_id_ingredient_id: key },
        create: { ...key, current_qty: qty },
        update: { current_qty: { increment: qty } },
        include: NAMED,
      });
      const { name, unit } = saved.ingredients;
      const added = new Prisma.Decimal(qty);
      const after = saved.current_qty;
      const details = { ingredient: name, unit, qty: added.toString(), before: after.minus(added).toString(), after: after.toString() };
      await logActivity(tx, tenant, key.location_id, 'STOCK_RECEIVE', details, ingredientId);
      return saved;
    });
  }
}
