// Dev/demo seed (idempotent): `npm run db:seed -w apps/api`.
// Phase 2.11 extends it with menus, inventory and the MULTI demo org.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const ROLES = [
  ['OWNER', 'Dueña Demo', 'dueno'],
  ['CASHIER', 'Cajero Demo', 'cajero'],
  ['WAITER', 'Mesera Demo', 'mesero'],
  ['KITCHEN', 'Cocina Demo', 'cocina'],
] as const;

async function main() {
  const db = new PrismaService();
  const password = process.env.SEED_PASSWORD || randomBytes(9).toString('base64url');
  const passwordHash = await hashPassword(password);

  const org = await db.organizations.upsert({
    where: { slug: 'cafe-ejemplo' },
    update: {},
    create: { name: 'Café Ejemplo', slug: 'cafe-ejemplo', plan_tier: 'SINGLE', max_locations: 1 },
  });
  if (!(await db.locations.findFirst({ where: { organization_id: org.id } }))) {
    await db.locations.create({
      data: { organization_id: org.id, name: 'Sede Chapinero', city: 'Bogotá', address: 'Cra. 7 #60-20' },
    });
  }
  for (const [role, fullName, alias] of ROLES) {
    const email = `${alias}@cafe-ejemplo.demo`;
    await db.users.upsert({
      where: { email },
      update: { password_hash: passwordHash },
      create: { organization_id: org.id, email, password_hash: passwordHash, full_name: fullName, role },
    });
  }
  await db.$disconnect();

  console.log('Seed OK: Café Ejemplo (SINGLE) con usuarios dueno|cajero|mesero|cocina@cafe-ejemplo.demo');
  if (!process.env.SEED_PASSWORD) console.log(`Contraseña generada (solo se muestra ahora): ${password}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
