import { ForbiddenException, Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { DEACTIVATED, SUSPENDED } from '../../auth/auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { PlanTier, Role } from './tenant-context';
import './tenant-context';

interface JwtClaims {
  sub: string;
  /** Only platform tokens carry an audience; they never open the tenant API. */
  aud?: string;
}

/**
 * Resolves the tenant from the signed JWT, never from client-supplied org ids.
 * Organization, role and allowed locations are read from the DB on each request
 * so revoked access takes effect immediately.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException();

    let claims: JwtClaims;
    try {
      claims = await this.jwt.verifyAsync<JwtClaims>(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (claims.aud) throw new UnauthorizedException();

    const user = await this.prisma.users.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        role: true,
        is_active: true,
        allowed_location_ids: true,
        organizations: {
          select: {
            id: true,
            plan_tier: true,
            max_locations: true,
            suspended_at: true,
            locations: { where: { is_active: true }, select: { id: true } },
          },
        },
      },
    });
    if (!user) throw new UnauthorizedException();

    const org = user.organizations;
    if (org.suspended_at) throw new ForbiddenException(SUSPENDED);
    if (!user.is_active) throw new ForbiddenException(DEACTIVATED);
    const orgLocationIds = org.locations.map((l) => l.id);
    // Empty allowed_location_ids = every location of the org (Prisma reads SQL NULL as []).
    const allowed = user.allowed_location_ids;
    const locationIds = allowed.length ? orgLocationIds.filter((id) => allowed.includes(id)) : orgLocationIds;

    const requested = req.header('x-location-id');
    let locationId: string | undefined;
    if (requested) {
      if (!locationIds.includes(requested)) throw new ForbiddenException('Location not allowed');
      locationId = requested;
    } else if (locationIds.length === 1) {
      // SINGLE plan UI never sends a location; it is still always resolved.
      locationId = locationIds[0];
    }

    req.tenant = {
      userId: user.id,
      role: user.role as Role,
      organizationId: org.id,
      planTier: org.plan_tier as PlanTier,
      maxLocations: org.max_locations,
      locationId,
      locationIds,
    };
    next();
  }
}
