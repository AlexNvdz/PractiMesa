import { BadRequestException, Body, Controller, HttpCode, Logger, Param, ParseUUIDPipe, Post, Query, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { uuid } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { InvoicingService } from '../invoicing/invoicing.service';
import { lockOrder, settleOrder } from '../orders/settle';
import { PrismaService } from '../prisma/prisma.service';
import { FactusPayService, PayAccount } from './factus-pay.service';

const digest = (value: string) => createHash('sha256').update(value).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * Factus Pay calls this when a collection becomes paid (POST, secret in ?key=, retried on non-2xx).
 * The webhook is only a hint: the payment is confirmed with GET /v1/collections/:ref (status and exact
 * amount) using the account of the business before the order is marked paid. Repeated calls are no-ops.
 * Public route: TenantMiddleware skips webhooks/*, the organization comes from the order.
 */
@Controller('webhooks/factus-pay')
export class FactusPayWebhookController {
  private readonly logger = new Logger(FactusPayWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pay: FactusPayService,
    private readonly invoicing: InvoicingService,
  ) {}

  /** Shared account of the environment: only orders of businesses without their own account. */
  @Post()
  @HttpCode(200)
  shared(@Query('key') key: unknown, @Body() body: unknown) {
    return this.handle(this.pay.sharedAccount(), null, key, body);
  }

  /** Account of one business: the URL it registers in its own Factus Pay panel. */
  @Post(':organizationId')
  @HttpCode(200)
  async own(@Param('organizationId', ParseUUIDPipe) organizationId: string, @Query('key') key: unknown, @Body() body: unknown) {
    return this.handle(await this.pay.ownAccount(organizationId), organizationId, key, body);
  }

  private async handle(account: PayAccount | null, organizationId: string | null, key: unknown, body: unknown) {
    if (!account || typeof key !== 'string' || !sameSecret(key, account.webhookKey)) throw new UnauthorizedException();
    const reference = (body as { data?: { reference_code?: unknown } } | null)?.data?.reference_code;
    if (!uuid(reference)) throw new BadRequestException('reference_code inválido');

    // System path: the webhook has no tenant; the order says which business it belongs to.
    const order = await this.prisma.orders.findUnique({
      where: { id: reference as string },
      select: { organization_id: true, location_id: true },
    });
    const ofThisAccount =
      order && (organizationId ? order.organization_id === organizationId : !(await this.pay.hasOwnAccount(order.organization_id)));
    if (!order || !ofThisAccount) return { result: 'ignored' };

    const collection = await this.pay.getCollection(account, reference as string);
    if (collection?.status !== 'paid') return { result: 'not paid' };

    const result = await this.prisma.tenantTransaction(order.organization_id, async (tx) => {
      const locked = await lockOrder(tx, reference as string, order.location_id);
      if (locked?.payment_status !== 'PENDING_QR') return 'not pending';
      if (!new Prisma.Decimal(collection.amount).equals(locked.due)) return 'amount mismatch';
      // The sale goes into the open register if there is one; a payment made after closing still counts.
      const [register] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM cash_registers WHERE location_id = ${order.location_id}::uuid AND status = 'OPEN' FOR SHARE`;
      await settleOrder(tx, reference as string, order.location_id, locked, {
        payment_method: 'FACTUS_PAY_QR',
        tip_cop: locked.tip,
        cash_register_id: register?.id ?? null,
      });
      return 'paid';
    });
    if (result === 'paid') {
      await this.prisma.webhook_events.createMany({
        data: [{ provider: 'FACTUS_PAY', external_event_id: reference as string, payload: body as Prisma.InputJsonValue, processed: true, processed_at: new Date() }],
        skipDuplicates: true,
      });
      // The invoice the customer asked for (if any) goes out right after the payment.
      void this.invoicing.emit(reference as string);
    } else {
      this.logger.warn(`Factus Pay paid ${reference as string} but the order was not settled: ${result}`);
    }
    return { result };
  }
}
