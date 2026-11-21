import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { int, parseBody, text } from '../common/validation';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const CATEGORY = { name: text(100), sort_order: int(0, 10_000) };

/** Menu categories (organization-wide). Deleting one leaves its products without category. */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    return this.prisma
      .forTenant(req.tenant!.organizationId)
      .categories.findMany({ orderBy: [{ sort_order: 'asc' }, { name: 'asc' }] });
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody<Prisma.categoriesUncheckedCreateInput>(body, CATEGORY, ['name']);
    return this.prisma.forTenant(req.tenant!.organizationId).categories.create({ data });
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const data = parseBody<Prisma.categoriesUncheckedUpdateInput>(body, CATEGORY);
    return this.prisma.forTenant(req.tenant!.organizationId).categories.update({ where: { id }, data });
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.forTenant(req.tenant!.organizationId).categories.delete({ where: { id } });
  }
}
