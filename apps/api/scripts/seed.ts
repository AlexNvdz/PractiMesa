// Dev/demo seed (idempotent): `npm run db:seed -w apps/api`.
// Phase 2.11 extends it with menus and inventory.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'WAITER' | 'KITCHEN';
/** Demo users: everyone has username + PIN 1234 (Q35); only the owner also has email + password (Q46). `at` = location indexes, [] = all. */
interface DemoUser {
  role: Role;
  name: string;
  username: string;
  at?: number[];
}
interface DemoOrg {
  handle: string;
  name: string;
  plan: 'SINGLE' | 'MULTI';
  ownerEmail: string;
  locations: { name: string; city: string; address: string }[];
  users: DemoUser[];
}

const STAFF: DemoUser[] = [
  { role: 'OWNER', name: 'Dueña Demo', username: 'duena.demo' },
  { role: 'ADMIN', name: 'Supervisor Demo', username: 'admin.demo' },
  { role: 'CASHIER', name: 'Cajero Demo', username: 'cajero.demo' },
  { role: 'WAITER', name: 'Mesera Demo', username: 'mesera.demo' },
  { role: 'KITCHEN', name: 'Cocina Demo', username: 'cocina.demo' },
];

const ORGS: DemoOrg[] = [
  {
    handle: 'cafe_ejemplo',
    name: 'Café Ejemplo',
    plan: 'SINGLE',
    ownerEmail: 'dueno@cafe-ejemplo.demo',
    locations: [{ name: 'Sede Chapinero', city: 'Bogotá', address: 'Cra. 7 #60-20' }],
    users: STAFF,
  },
  {
    handle: 'cadena_ejemplo',
    name: 'Cadena Ejemplo',
    plan: 'MULTI',
    ownerEmail: 'dueno@cadena-ejemplo.demo',
    locations: [
      { name: 'Sede Norte', city: 'Bogotá', address: 'Calle 100 #15-20' },
      { name: 'Sede Sur', city: 'Bogotá', address: 'Av. 1 de Mayo #30-10' },
    ],
    // One supervisor per location, staff of each location, the kitchen lead in both.
    users: [
      { role: 'OWNER', name: 'Dueño Demo', username: 'dueno.demo' },
      { role: 'ADMIN', name: 'Supervisora Norte', username: 'super.norte', at: [0] },
      { role: 'ADMIN', name: 'Supervisor Sur', username: 'super.sur', at: [1] },
      { role: 'CASHIER', name: 'Cajero Norte', username: 'cajero.norte', at: [0] },
      { role: 'CASHIER', name: 'Cajera Sur', username: 'cajera.sur', at: [1] },
      { role: 'WAITER', name: 'Mesero Norte', username: 'mesero.norte', at: [0] },
      { role: 'WAITER', name: 'Mesera Sur', username: 'mesera.sur', at: [1] },
      { role: 'KITCHEN', name: 'Cocina Demo', username: 'cocina.demo', at: [] },
    ],
  },
];

async function seedOrg(db: PrismaService, demo: DemoOrg, passwordHash: string, pinHash: string) {
  const org =
    (await db.organizations.findFirst({ where: { handle: demo.handle } })) ??
    (await db.organizations.create({
      data: { name: demo.name, handle: demo.handle, plan_tier: demo.plan, max_locations: demo.locations.length },
    }));
  const locationIds: string[] = [];
  for (const location of demo.locations) {
    const found = await db.locations.findFirst({ where: { organization_id: org.id, name: location.name } });
    locationIds.push((found ?? (await db.locations.create({ data: { ...location, organization_id: org.id } }))).id);
  }
  for (const user of demo.users) {
    const owner = user.role === 'OWNER';
    // Before usernames existed, users were found by role (the owner by email).
    const existing =
      (await db.users.findFirst({ where: { organization_id: org.id, username: user.username } })) ??
      (owner ? await db.users.findUnique({ where: { email: demo.ownerEmail } }) : null) ??
      (await db.users.findFirst({ where: { organization_id: org.id, role: user.role, username: null } }));
    const data = {
      username: user.username,
      pin_hash: pinHash,
      email: owner ? demo.ownerEmail : null,
      password_hash: owner ? passwordHash : null,
      allowed_location_ids: (user.at ?? []).map((i) => locationIds[i]),
    };
    if (existing) await db.users.update({ where: { id: existing.id }, data });
    else await db.users.create({ data: { ...data, organization_id: org.id, full_name: user.name, role: user.role } });
  }
  console.log(`${demo.name} (@${demo.handle}, ${demo.locations.length} sede(s)). Dueño: ${demo.ownerEmail}. PIN 1234: ${demo.users.map((u) => u.username).join(', ')}`);
}

async function main() {
  const db = new PrismaService();
  const password = process.env.SEED_PASSWORD || randomBytes(9).toString('base64url');
  const [passwordHash, pinHash] = await Promise.all([hashPassword(password), hashPassword('1234')]);
  for (const demo of ORGS) await seedOrg(db, demo, passwordHash, pinHash);
  await db.$disconnect();
  if (!process.env.SEED_PASSWORD) console.log(`Contraseña generada (solo se muestra ahora): ${password}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
