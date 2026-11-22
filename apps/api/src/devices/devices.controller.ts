import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DEVICE_COOKIE, readCookie } from '../auth/auth.controller';
import { CODE_TTL_MS, linkCodeHash, newLinkCode, sha256 } from '../auth/auth.service';
import { Roles } from '../common/guards/roles.guard';
import { parseBody, text, uuid } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

const DEVICE = {
  id: true,
  name: true,
  location_id: true,
  last_used_at: true,
  created_at: true,
  token_hash: true,
  locations: { select: { name: true } },
} as const;

/**
 * Linked devices: browsers where the team signs in with username + PIN, each at one location.
 * Only the owner links them (one-time code) and unlinks them (deleted, with their sessions).
 */
@Controller('devices')
@Roles('OWNER')
export class DevicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    const mine = readCookie(req, DEVICE_COOKIE);
    const devices = await this.prisma.forTenant(req.tenant!.organizationId).devices.findMany({
      select: DEVICE,
      orderBy: { created_at: 'desc' },
    });
    // The token hash never leaves the API: only whether it is this browser.
    return devices.map(({ token_hash, ...d }) => ({ ...d, current: !!mine && token_hash === sha256(mine) }));
  }

  /** One-time code (10 minutes) the new device types after the handle; it carries the location and name. */
  @Post('codes')
  async code(@Req() req: Request, @Body() body: unknown) {
    const tenant = req.tenant!;
    const data = parseBody<{ name: string; location_id?: string }>(body, { name: text(80), location_id: uuid }, ['name']);
    const locationId = tenant.planTier === 'SINGLE' ? tenant.locationIds[0] : data.location_id;
    if (!locationId || !tenant.locationIds.includes(locationId)) throw new BadRequestException('Elige una sede activa');

    const code = newLinkCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      await tx.device_codes.deleteMany({ where: { expires_at: { lte: new Date() } } });
      await tx.device_codes.create({
        data: { name: data.name, location_id: locationId, code_hash: linkCodeHash(code), created_by: tenant.userId, expires_at: expiresAt },
      });
    });
    return { code, expires_at: expiresAt };
  }

  /** Unlinking deletes the device; its PIN sessions go with it (refresh_tokens cascade, TenantMiddleware finds no device). */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.forTenant(req.tenant!.organizationId).devices.delete({ where: { id } });
  }
}
