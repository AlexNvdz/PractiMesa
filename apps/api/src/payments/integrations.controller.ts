import { Body, Controller, Delete, Get, HttpCode, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { parseBody, text } from '../common/validation';
import { PrismaService } from '../prisma/prisma.service';
import { FactusPayService } from './factus-pay.service';

const FACTUS_PAY = {
  email: (v: unknown) => text(150)(v) && /^\S+@\S+$/.test(v as string),
  password: text(200),
  // The business chooses it in its Factus Pay panel; Factus Pay recommends 32+ random characters.
  webhook_key: (v: unknown) => typeof v === 'string' && v.length >= 32 && v.length <= 200,
};

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
  ) {}

  @Get()
  async status(@Req() req: Request) {
    const organizationId = req.tenant!.organizationId;
    const pay = await this.prisma.organization_credentials.findUnique({
      where: { organization_id_provider: { organization_id: organizationId, provider: 'FACTUS_PAY' } },
      select: { updated_at: true },
    });
    return {
      factus_pay: {
        configured: pay !== null,
        updated_at: pay?.updated_at ?? null,
        // To register in the Factus Pay panel, followed by ?key=<webhook_key>.
        webhook_path: `/api/webhooks/factus-pay/${organizationId}`,
      },
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

  /** The business goes back to the shared demo account (if the environment has one). */
  @Delete('factus-pay')
  @HttpCode(204)
  async removeFactusPay(@Req() req: Request) {
    await this.pay.removeAccount(req.tenant!.organizationId);
  }
}
