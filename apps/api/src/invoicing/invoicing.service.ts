import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FactusService } from './factus.service';
import { invoicePayload } from './invoice-payload';

/** Attempts per invoice before it is left in ERROR for a person to look at. */
export const MAX_ATTEMPTS = 10;

interface FactusResponse {
  message?: string;
  data?: {
    is_validated?: boolean;
    number?: string;
    cufe?: string;
    links?: { qr?: string; public_url?: string };
    message?: string;
    errors?: Record<string, string | string[]>;
  };
}

/** Factus and DIAN messages in one line: "field: message; RULE: message". */
function describe(body: FactusResponse, fallback: string) {
  const errors = Object.entries(body.data?.errors ?? {}).map(([k, v]) => `${k}: ${([] as string[]).concat(v).join(' ')}`);
  return (errors.length ? errors.join('; ') : (body.data?.message ?? body.message ?? fallback)).slice(0, 1000);
}

/**
 * Emits the electronic invoice of paid orders that asked for one (Q6/Q16): no queue, the state lives on the
 * order (factus_status) and a job retries every minute. The order id is the Factus reference_code, so a
 * repeated send returns the existing invoice instead of creating a second one.
 */
@Injectable()
export class InvoicingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoicingService.name);
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly factus: FactusService,
  ) {}

  // shortcut: in-process timer, one API instance (Q16); move to a real queue before running several instances.
  onModuleInit() {
    if (process.env.INVOICE_JOB === 'off') return;
    this.timer = setInterval(() => void this.processPending(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** System path: every business's paid orders waiting for their invoice. */
  async processPending() {
    const pending = await this.prisma.orders.findMany({
      where: { factus_status: 'PENDING', payment_status: 'PAID' },
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: 20,
    });
    for (const { id } of pending) await this.emit(id);
  }

  /** One attempt for a paid order waiting for its invoice. Never throws: the outcome is stored on the order. */
  async emit(orderId: string) {
    if (this.inFlight.has(orderId)) return;
    this.inFlight.add(orderId);
    try {
      const order = await this.prisma.orders.findFirst({
        where: { id: orderId, factus_status: 'PENDING', payment_status: 'PAID' },
        include: { order_items: { where: { voided_at: null }, include: { products: { select: { name: true } } } } },
      });
      if (order) await this.prisma.orders.update({ where: { id: orderId }, data: await this.send(order) });
    } catch (err) {
      this.logger.error(`Invoice of order ${orderId} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight.delete(orderId);
    }
  }

  private async send(order: Parameters<typeof invoicePayload>[0] & { organization_id: string; factus_attempts: number }) {
    const attempts = order.factus_attempts + 1;
    const retry = (error: string): Prisma.ordersUpdateInput => ({
      factus_attempts: attempts,
      factus_error: error,
      factus_status: attempts >= MAX_ATTEMPTS ? 'ERROR' : 'PENDING',
    });
    try {
      const account = await this.factus.accountFor(order.organization_id);
      const res = await this.factus.validateBill(account, invoicePayload(order, account.numbering_range_id));
      const body = (await res.json().catch(() => ({}))) as FactusResponse;
      if (res.ok && body.data?.is_validated) {
        return {
          factus_status: 'VALIDATED',
          factus_attempts: attempts,
          factus_error: null,
          factus_invoice_number: body.data.number,
          factus_cufe: body.data.cufe,
          factus_qr_url: body.data.links?.qr,
          factus_pdf_url: body.data.links?.public_url,
        };
      }
      if (res.status === 400 || res.status === 422) {
        // Our data was rejected: sending it again will not help until someone fixes it.
        return { factus_status: 'ERROR', factus_attempts: attempts, factus_error: describe(body, `Factus respondió ${res.status}`) };
      }
      if (res.ok || res.status === 409) {
        // Registered at Factus but not validated by the DIAN: delete it so the next attempt sends it anew.
        await this.factus.deleteBill(account, order.id);
        return retry(describe(body, 'La DIAN no validó la factura'));
      }
      return retry(describe(body, `Factus respondió ${res.status}`));
    } catch (err) {
      return retry(err instanceof Error ? err.message : String(err));
    }
  }
}
