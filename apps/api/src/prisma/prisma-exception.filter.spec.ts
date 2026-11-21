import { ArgumentsHost, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../generated/prisma/client';
import { PrismaExceptionFilter, toHttpException } from './prisma-exception.filter';

const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError('db error', { code, clientVersion: 'test' });

describe('toHttpException', () => {
  it.each([
    ['P2025', 'PATCH', NotFoundException],
    ['P2002', 'POST', ConflictException],
    ['P2003', 'POST', BadRequestException],
    ['P2003', 'DELETE', ConflictException],
  ])('maps %s on %s', (code, method, expected) => {
    expect(toHttpException(prismaError(code), method)).toBeInstanceOf(expected);
  });

  it('leaves unexpected codes alone (500)', () => {
    expect(toHttpException(prismaError('P1001'), 'GET')).toBeUndefined();
  });
});

describe('PrismaExceptionFilter', () => {
  const host = (method: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ method }) }) }) as unknown as ArgumentsHost;

  it('hands the mapped exception, or the original one, to the base filter', () => {
    const base = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const filter = new PrismaExceptionFilter();
    filter.catch(prismaError('P2025'), host('GET'));
    expect(base.mock.calls[0][0]).toBeInstanceOf(NotFoundException);
    const unknown = prismaError('P1001');
    filter.catch(unknown, host('GET'));
    expect(base.mock.calls[1][0]).toBe(unknown);
    base.mockRestore();
  });
});
