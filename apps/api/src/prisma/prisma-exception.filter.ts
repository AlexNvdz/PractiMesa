import { ArgumentsHost, BadRequestException, Catch, ConflictException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { Prisma } from '../generated/prisma/client';

/** Maps expected DB errors to 4xx. RLS hides other organizations' rows, so they surface as 404. */
export function toHttpException(err: Prisma.PrismaClientKnownRequestError, method: string) {
  switch (err.code) {
    case 'P2025':
      return new NotFoundException('Registro no encontrado');
    case 'P2002':
      return new ConflictException('Ya existe un registro con esos datos');
    case 'P2003':
      return method === 'DELETE'
        ? new ConflictException('No se puede eliminar: tiene registros asociados')
        : new BadRequestException('Referencia inválida');
    default:
      return undefined;
  }
}

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  catch(err: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    super.catch(toHttpException(err, host.switchToHttp().getRequest<Request>().method) ?? err, host);
  }
}
