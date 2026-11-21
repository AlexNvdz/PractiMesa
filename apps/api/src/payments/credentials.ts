import type { PrismaService } from '../prisma/prisma.service';
import { seal, unseal } from './sealed';

/** Integration accounts a business can connect (organization_credentials.provider). */
export type Provider = 'FACTUS_PAY' | 'FACTUS';

const key = (organization_id: string, provider: Provider) => ({ organization_id_provider: { organization_id, provider } });
const context = (organizationId: string, provider: Provider) => `${organizationId}:${provider}`;

/** System path: organization_credentials has no grant for the tenant role. */
export async function readCredentials<T>(prisma: PrismaService, organizationId: string, provider: Provider): Promise<T | null> {
  const row = await prisma.organization_credentials.findUnique({ where: key(organizationId, provider) });
  return row ? (JSON.parse(unseal(row.sealed, context(organizationId, provider))) as T) : null;
}

export async function hasCredentials(prisma: PrismaService, organizationId: string, provider: Provider) {
  return (await prisma.organization_credentials.count({ where: { organization_id: organizationId, provider } })) > 0;
}

export async function writeCredentials(prisma: PrismaService, organizationId: string, provider: Provider, value: object) {
  const sealed = seal(JSON.stringify(value), context(organizationId, provider));
  await prisma.organization_credentials.upsert({
    where: key(organizationId, provider),
    create: { organization_id: organizationId, provider, sealed },
    update: { sealed, updated_at: new Date() },
  });
}

export async function deleteCredentials(prisma: PrismaService, organizationId: string, provider: Provider) {
  await prisma.organization_credentials.deleteMany({ where: { organization_id: organizationId, provider } });
}
