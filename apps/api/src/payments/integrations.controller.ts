import { Body, Controller, Delete, Get, HttpCode, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { email, int, parseBody, text } from '../common/validation';
import { FactusService } from '../invoicing/factus.service';
import { PrismaService } from '../prisma/prisma.service';
import { FactusPayService } from './factus-pay.service';

const FACTUS_PAY = {
  email,
  password: text(200),
  // The business chooses it in its Factus Pay panel; Factus Pay recommends 32+ random characters.
  webhook_key: (v: unknown) => typeof v === 'string' && v.length >= 32 && v.length <= 200,
};
const FACTUS = { client_id: text(100), client_secret: text(200), username: email, password: text(200), numbering_range_id: int(1, 2_000_000_000) };
type FactusBody = { client_id: string; client_secret: string; username: string; password: string; numbering_range_id?: number };

/**
 * Payment and invoicing accounts of the business (owner only). Secrets are write-only: they are stored
 * sealed and never returned. organization_credentials is system-only, so these queries use the base client
 * filtered by the organization of the signed-in owner.
 */
@Controller('integrations')
@Roles('OWNER')
export class IntegrationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pay: FactusPayService,
    private readonly factus: FactusService,
  ) {}

  @Get()
  async status(@Req() req: Request) {
    const organizationId = req.tenant!.organizationId;
    const rows = await this.prisma.organization_credentials.findMany({
      where: { organization_id: organizationId },
      select: { provider: true, updated_at: true },
    });
    const pay = rows.find((r) => r.provider === 'FACTUS_PAY') ?? null;
    const factus = rows.find((r) => r.provider === 'FACTUS') ?? null;
    return {
      factus_pay: {
        configured: pay !== null,
        updated_at: pay?.updated_at ?? null,
        // To register in the Factus Pay panel, followed by ?key=<webhook_key>.
        webhook_path: `/api/webhooks/factus-pay/${organizationId}`,
      },
      factus: { configured: factus !== null, updated_at: factus?.updated_at ?? null },
    };
  }

  @Put('factus-pay')
  async setFactusPay(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody<{ email: string; password: string; webhook_key: string }>(body, FACTUS_PAY, ['email', 'password', 'webhook_key']);
    // Taken untrimmed: a password may start or end with spaces.
    const password = (body as { password: string }).password;
    await this.pay.saveAccount(req.tenant!.organizationId, { email: data.email, password, webhookKey: data.webhook_key });
    return this.status(req);
  }

  /** Factus e-invoicing account of the business (its NIT and numbering range). */
  @Put('factus')
  async setFactus(@Req() req: Request, @Body() body: unknown) {
    const data = parseBody<FactusBody>(body, FACTUS, ['client_id', 'client_secret', 'username', 'password']);
    await this.factus.saveAccount(req.tenant!.organizationId, { ...data, password: (body as { password: string }).password });
    return this.status(req);
  }

  @Delete('factus')
  @HttpCode(204)
  async removeFactus(@Req() req: Request) {
    await this.factus.removeAccount(req.tenant!.organizationId);
  }

  /** The business goes back to the shared demo account (if the environment has one). */
  @Delete('factus-pay')
  @HttpCode(204)
  async removeFactusPay(@Req() req: Request) {
    await this.pay.removeAccount(req.tenant!.organizationId);
  }
}
