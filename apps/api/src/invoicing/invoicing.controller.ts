import { BadRequestException, Body, ConflictException, Controller, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/guards/roles.guard';
import { requireLocation } from '../common/tenant/tenant-context';
import { email, oneOf, parseBody, text } from '../common/validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceCustomer } from './invoice-payload';
import { InvoicingService } from './invoicing.service';

/** Factus customer fields; identification document codes from the DIAN table. */
const CUSTOMER = {
  identification_document_code: oneOf('11', '12', '13', '21', '22', '31', '41', '42', '47', '48', '50', '91'),
  identification: (v: unknown) => typeof v === 'string' && /^[0-9A-Za-z]{3,20}$/.test(v),
  dv: (v: unknown) => typeof v === 'string' && /^\d$/.test(v),
  legal_organization_code: oneOf('1', '2'),
  names: text(150),
  company: text(150),
  email,
  phone: text(30),
  address: text(200),
  municipality_code: (v: unknown) => typeof v === 'string' && /^\d{5}$/.test(v),
};

const INVOICE_FIELDS = {
  id: true,
  order_number: true,
  payment_status: true,
  factus_status: true,
  factus_invoice_number: true,
  factus_cufe: true,
  factus_qr_url: true,
  factus_pdf_url: true,
  factus_error: true,
  invoice_customer: true,
} satisfies Prisma.ordersSelect;

/** Without `customer` the invoice goes to "consumidor final"; a company needs `company`, a person `names`. */
function parseCustomer(body: unknown): InvoiceCustomer | null {
  const raw = (body as { customer?: unknown } | null)?.customer;
  if (raw === undefined || raw === null) return null;
  const customer = parseBody<InvoiceCustomer>(raw, CUSTOMER, ['identification_document_code', 'identification', 'legal_organization_code']);
  if (customer.legal_organization_code === '1' ? !customer.company : !customer.names) {
    throw new BadRequestException('Falta la razón social de la empresa o el nombre de la persona');
  }
  return customer;
}

/**
 * The customer asked for an electronic invoice (Q6): the order waits in factus_status PENDING and is invoiced
 * as soon as it is paid (right away if it already is; otherwise the job does it after the payment).
 */
@Controller('orders/:id/invoice')
export class InvoicingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoicing: InvoicingService,
  ) {}

  @Post()
  @Roles('OWNER', 'ADMIN', 'CASHIER')
  async request(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    const customer = parseCustomer(body);
    const db = this.prisma.forTenant(tenant.organizationId);

    // A customer who gives a phone is kept for next time (customers are unique per phone).
    const saved = customer?.phone
      ? await db.customers.upsert({
          where: { organization_id_phone: { organization_id: tenant.organizationId, phone: customer.phone } },
          create: this.customerRow(customer),
          update: this.customerRow(customer),
        })
      : null;

    // Conditional update: a second request (or a cancelled order) changes nothing.
    const { count } = await db.orders.updateMany({
      where: { id, location_id: locationId, status: { not: 'CANCELLED' }, factus_status: { in: ['NOT_SENT', 'ERROR'] } },
      data: {
        factus_status: 'PENDING',
        factus_attempts: 0,
        factus_error: null,
        invoice_customer: customer ? (customer as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        ...(saved ? { customer_id: saved.id } : {}),
      },
    });
    if (!count) {
      const order = await db.orders.findFirst({ where: { id, location_id: locationId }, select: { status: true } });
      if (!order) throw new NotFoundException('Registro no encontrado');
      throw new ConflictException(
        order.status === 'CANCELLED' ? 'El pedido está cancelado' : 'El pedido ya tiene una factura emitida o en proceso',
      );
    }
    await this.invoicing.emit(id);
    return db.orders.findFirst({ where: { id }, select: INVOICE_FIELDS });
  }

  private customerRow(customer: InvoiceCustomer) {
    return {
      full_name: (customer.company ?? customer.names)!,
      phone: customer.phone!,
      email: customer.email ?? null,
      identification_type: customer.identification_document_code,
      identification_number: customer.identification,
    };
  }
}
