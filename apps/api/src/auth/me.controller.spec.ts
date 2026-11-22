// Integration test: needs Postgres with migrations applied.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthService } from './auth.service';
import { MeController } from './me.controller';

const db = new PrismaService();
const suffix = randomUUID().slice(0, 8);
let orgId: string;
let userId: string;
let locationId: string;

beforeAll(async () => {
  orgId = (await db.organizations.create({ data: { name: 'Me test', handle: `me_${suffix}`, plan_tier: 'SINGLE' } })).id;
  locationId = (
    await db.locations.create({ data: { organization_id: orgId, name: 'Centro', city: 'Cali', address: 'Calle 5' } })
  ).id;
  userId = (
    await db.users.create({
      data: { organization_id: orgId, email: `me-${suffix}@test.demo`, password_hash: 'x', full_name: 'Ana', role: 'CASHIER' },
    })
  ).id;
});

afterAll(async () => {
  await db.organizations.delete({ where: { id: orgId } });
  await db.$disconnect();
});

it('returns the session user, organization and allowed locations', async () => {
  const req = {
    tenant: { userId, organizationId: orgId, role: 'CASHIER', planTier: 'SINGLE', maxLocations: 1, locationId, locationIds: [locationId] },
  } as unknown as Request;

  await expect(new MeController(db, {} as AuthService).me(req)).resolves.toEqual({
    user: { id: userId, full_name: 'Ana', given_names: null, family_names: null, email: `me-${suffix}@test.demo`, role: 'CASHIER', username: null, has_pin: false },
    organization: { id: orgId, name: 'Me test', handle: `me_${suffix}`, plan_tier: 'SINGLE', max_locations: 1 },
    locations: [{ id: locationId, name: 'Centro', city: 'Cali' }],
    current_location_id: locationId,
    device: null,
  });
});
