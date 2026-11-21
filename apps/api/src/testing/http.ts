// Test-only helpers (excluded from build, coverage and Sonar sources): real AppModule over HTTP + Postgres fixtures.
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { Role } from '../common/tenant/tenant-context';
import { PrismaService } from '../prisma/prisma.service';

export async function startApp(): Promise<INestApplication> {
  // CI has no .env; JwtModule reads the secret when AppModule is loaded, hence the dynamic import.
  process.env.JWT_SECRET ??= 'test-secret';
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  return app;
}

export interface TestOrg {
  id: string;
  locations: string[];
  users: Record<'OWNER' | 'ADMIN' | 'CASHIER', string>;
}

export async function createOrg(db: PrismaService, plan: 'SINGLE' | 'MULTI', locationCount: number): Promise<TestOrg> {
  const suffix = randomUUID().slice(0, 8);
  const org = await db.organizations.create({
    data: { name: `Test ${suffix}`, slug: `t-${suffix}`, plan_tier: plan, max_locations: plan === 'SINGLE' ? 1 : 3 },
  });
  const locations: string[] = [];
  for (let i = 1; i <= locationCount; i++) {
    const location = await db.locations.create({
      data: { organization_id: org.id, name: `Sede ${i}`, city: 'Cali', address: 'Calle 1' },
    });
    locations.push(location.id);
  }
  const users = {} as TestOrg['users'];
  for (const role of ['OWNER', 'ADMIN', 'CASHIER'] satisfies Role[]) {
    const user = await db.users.create({
      data: { organization_id: org.id, email: `${role.toLowerCase()}-${suffix}@test.demo`, password_hash: 'x', full_name: role, role },
    });
    users[role] = user.id;
  }
  return { id: org.id, locations, users };
}

export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** HTTP client logged in as the user, optionally sending x-location-id. */
export async function client(app: INestApplication, userId: string, locationId?: string): Promise<Call> {
  const token = await app.get(JwtService).signAsync({ sub: userId });
  const base = await app.getUrl();
  return async (method, path, body) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(locationId ? { 'x-location-id': locationId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}
