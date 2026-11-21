import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

/** DB role subject to RLS (migration 0002). The connecting user bypasses RLS: system path only. */
const APP_ROLE = 'practimesa_app';

/**
 * Base client = system path (bypasses RLS): migrations, seeds, auth lookups, webhooks, jobs.
 * Request code must use forTenant() / tenantTransaction(), which run as APP_ROLE with app.org_id set,
 * so Postgres RLS limits every query to that organization.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private tenantContext(client: Pick<PrismaClient, '$executeRaw'>, organizationId: string) {
    return client.$executeRaw`SELECT set_config('role', ${APP_ROLE}, true), set_config('app.org_id', ${organizationId}, true)`;
  }

  /** Client whose every query (models and raw) runs in its own transaction scoped to the organization. */
  forTenant(organizationId: string) {
    return this.$extends({
      query: {
        $allOperations: async ({ args, query }) => {
          const [, result] = await this.$transaction([this.tenantContext(this, organizationId), query(args)]);
          return result;
        },
      },
    });
  }

  /** Multi-step atomic work scoped to the organization. */
  tenantTransaction<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await this.tenantContext(tx, organizationId);
      return fn(tx);
    });
  }
}
