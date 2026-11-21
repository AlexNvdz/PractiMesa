import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { parseBody, text } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** unit is free text ('gr', 'ml', 'und'...); recipes and stock use the same unit. */
const INGREDIENT = { name: text(120), unit: text(20) };

/** Inventory ingredients (organization-wide). Deleting one removes it from recipes and stock. */
@Controller('ingredients')
export class IngredientsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    return this.prisma.forTenant(req.tenant!.organizationId).ingredients.findMany({ orderBy: { name: 'asc' } });
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody<Prisma.ingredientsUncheckedCreateInput>(body, INGREDIENT, ['name', 'unit']);
    return this.prisma.forTenant(req.tenant!.organizationId).ingredients.create({ data });
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.ingredientsUncheckedUpdateInput>(body, INGREDIENT);
    return this.prisma.forTenant(req.tenant!.organizationId).ingredients.update({ where: { id }, data });
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.forTenant(req.tenant!.organizationId).ingredients.delete({ where: { id } });
  }
}
