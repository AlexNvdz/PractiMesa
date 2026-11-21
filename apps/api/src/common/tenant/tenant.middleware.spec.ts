import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import type { PrismaService } from '../../prisma/prisma.service';
import { TenantMiddleware } from './tenant.middleware';

const jwt = new JwtService({ secret: 'test-secret' });
const LOC_A1 = 'loc-a1';
const LOC_A2 = 'loc-a2';

function dbUser(overrides: Partial<{ allowed_location_ids: string[]; locations: string[]; plan: string }> = {}) {
  return {
    id: 'user-a',
    role: 'CASHIER',
    allowed_location_ids: overrides.allowed_location_ids ?? [],
    organizations: {
      id: 'org-a',
      plan_tier: overrides.plan ?? 'MULTI',
      max_locations: 3,
      locations: (overrides.locations ?? [LOC_A1, LOC_A2]).map((id) => ({ id })),
    },
  };
}

function setup(user: unknown) {
  const findUnique = jest.fn().mockResolvedValue(user);
  const prisma = { users: { findUnique } } as unknown as PrismaService;
  return { mw: new TenantMiddleware(jwt, prisma), findUnique };
}

function req(token?: string, locationId?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (locationId) headers['x-location-id'] = locationId;
  return { headers, header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

const res = {} as Response;
const token = () => jwt.signAsync({ sub: 'user-a' });

describe('TenantMiddleware', () => {
  it('rejects requests without bearer token', async () => {
    const { mw } = setup(dbUser());
    await expect(mw.use(req(), res, jest.fn())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects tokens signed with another secret', async () => {
    const { mw } = setup(dbUser());
    const forged = await new JwtService({ secret: 'attacker' }).signAsync({ sub: 'user-a' });
    await expect(mw.use(req(forged), res, jest.fn())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects tokens of deleted users', async () => {
    const { mw } = setup(null);
    await expect(mw.use(req(await token()), res, jest.fn())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('takes the organization from the DB user, looked up by token subject only', async () => {
    const { mw, findUnique } = setup(dbUser());
    const r = req(await token(), LOC_A2);
    const next = jest.fn();
    await mw.use(r, res, next);
    expect(findUnique.mock.calls[0][0].where).toEqual({ id: 'user-a' });
    expect(r.tenant).toMatchObject({ organizationId: 'org-a', locationId: LOC_A2, planTier: 'MULTI' });
    expect(next).toHaveBeenCalled();
  });

  it('forbids a location from another organization', async () => {
    const { mw } = setup(dbUser());
    await expect(mw.use(req(await token(), 'loc-of-org-b'), res, jest.fn())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('forbids an org location outside the user allowed list', async () => {
    const { mw } = setup(dbUser({ allowed_location_ids: [LOC_A1] }));
    await expect(mw.use(req(await token(), LOC_A2), res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('auto-resolves the only location (SINGLE plan) when no header is sent', async () => {
    const { mw } = setup(dbUser({ plan: 'SINGLE', locations: [LOC_A1] }));
    const r = req(await token());
    await mw.use(r, res, jest.fn());
    expect(r.tenant?.locationId).toBe(LOC_A1);
  });

  it('treats an empty allowed list (SQL NULL) as every org location', async () => {
    const { mw } = setup(dbUser({ allowed_location_ids: [] }));
    const r = req(await token(), LOC_A2);
    await mw.use(r, res, jest.fn());
    expect(r.tenant?.locationIds).toEqual([LOC_A1, LOC_A2]);
  });

  it('leaves location undefined for org-level requests with several locations', async () => {
    const { mw } = setup(dbUser());
    const r = req(await token());
    await mw.use(r, res, jest.fn());
    expect(r.tenant?.locationId).toBeUndefined();
    expect(r.tenant?.locationIds).toEqual([LOC_A1, LOC_A2]);
  });
});
