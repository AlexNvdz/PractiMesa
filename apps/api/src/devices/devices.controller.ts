import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { DEVICE_COOKIE, deviceCookieOptions, readCookie } from '../auth/auth.controller';
import { sha256 } from '../auth/auth.service';
import { Roles } from '../common/guards/roles.guard';
import type { TenantContext } from '../common/tenant/tenant-context';
import { parseBody, text, uuid } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';

const DEVICE = {
  id: true,
  name: true,
  location_id: true,
  last_used_at: true,
  revoked_at: true,
  created_at: true,
  token_hash: true,
  locations: { select: { name: true } },
  users: { select: { full_name: true } },
} as const;

/**
 * Authorized devices (Q29, Q33): browsers where workers may sign in with username + PIN, each at one location.
 * The owner manages every device; an admin only those of its locations (Q42).
 */
@Controller('devices')
@Roles('OWNER', 'ADMIN')
export class DevicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const mine = readCookie(req, DEVICE_COOKIE);
    const devices = await this.prisma.forTenant(tenant.organizationId).devices.findMany({
      where: this.scope(tenant),
      select: DEVICE,
      orderBy: [{ revoked_at: { sort: 'desc', nulls: 'first' } }, { created_at: 'desc' }],
    });
    // The token hash never leaves the API: only whether it is this browser.
    return devices.map(({ token_hash, ...d }) => ({ ...d, current: !!mine && token_hash === sha256(mine) }));
  }

  /** Authorizes this browser (sets the device cookie). Re-authorizing replaces this browser's previous device. */
  @Post()
  async authorize(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const tenant = req.tenant!;
    const data = parseBody<{ name: string; location_id?: string }>(body, { name: text(80), location_id: uuid }, ['name']);
    const locationId = tenant.planTier === 'SINGLE' ? tenant.locationIds[0] : data.location_id;
    if (!locationId || !tenant.locationIds.includes(locationId)) throw new BadRequestException('Elige una sede donde trabajes');

    const token = randomBytes(32).toString('base64url');
    const previous = readCookie(req, DEVICE_COOKIE);
    const device = await this.prisma.tenantTransaction(tenant.organizationId, async (tx) => {
      if (previous) {
        await tx.devices.updateMany({ where: { token_hash: sha256(previous), revoked_at: null }, data: { revoked_at: new Date() } });
      }
      return tx.devices.create({
        data: { name: data.name, location_id: locationId, token_hash: sha256(token), created_by: tenant.userId },
        select: DEVICE,
      });
    });
    res.cookie(DEVICE_COOKIE, token, deviceCookieOptions());
    const { token_hash: _, ...view } = device;
    return { ...view, current: true };
  }

  /** Revoking a device ends its PIN sessions (Q33): TenantMiddleware and refresh both check it. */
  @Post(':id/revoke')
  @HttpCode(204)
  async revoke(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const tenant = req.tenant!;
    const device = await this.prisma.forTenant(tenant.organizationId).devices.findUniqueOrThrow({ where: { id } });
    if (tenant.role !== 'OWNER' && !tenant.locationIds.includes(device.location_id)) {
      throw new ForbiddenException('Ese dispositivo es de una sede que no manejas');
    }
    await this.prisma.forTenant(tenant.organizationId).devices.update({ where: { id }, data: { revoked_at: device.revoked_at ?? new Date() } });
    // Refresh tokens live on the system path (no tenant grant); the device was checked above.
    await this.prisma.refresh_tokens.updateMany({ where: { device_id: id, revoked_at: null }, data: { revoked_at: new Date() } });
  }

  private scope(tenant: TenantContext) {
    return tenant.role === 'OWNER' ? {} : { location_id: { in: tenant.locationIds } };
  }
}
