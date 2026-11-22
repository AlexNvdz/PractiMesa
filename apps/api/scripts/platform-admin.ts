// Creates a platform admin (Q27), or resets the password of an existing one. There is no sign-up.
// PLATFORM_EMAIL=... PLATFORM_NAME=... PLATFORM_PASSWORD=... npm run platform:admin -w apps/api
// Env vars, not arguments, so the password stays out of shell history and process lists.
import 'dotenv/config';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const email = process.env.PLATFORM_EMAIL?.trim().toLowerCase();
  const name = process.env.PLATFORM_NAME?.trim();
  const password = process.env.PLATFORM_PASSWORD ?? '';
  if (!email?.includes('@') || !name || password.length < 12) {
    throw new Error('Define PLATFORM_EMAIL, PLATFORM_NAME y PLATFORM_PASSWORD (mínimo 12 caracteres).');
  }
  const db = new PrismaService();
  const password_hash = await hashPassword(password);
  const existing = await db.platform_admins.findFirst({ where: { email } });
  if (existing) await db.platform_admins.update({ where: { id: existing.id }, data: { password_hash, full_name: name } });
  else await db.platform_admins.create({ data: { email, password_hash, full_name: name } });
  await db.$disconnect();
  console.log(`${existing ? 'Contraseña actualizada' : 'Cuenta creada'}: ${email}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
