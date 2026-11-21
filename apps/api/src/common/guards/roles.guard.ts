import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '../tenant/tenant-context';

const ROLES_KEY = 'roles';

/** Restricts a route or controller to these roles. Routes without @Roles stay open to any logged-in user. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const role = ctx.switchToHttp().getRequest<Request>().tenant?.role;
    if (!role || !roles.includes(role)) throw new ForbiddenException('No tienes permiso para esta acción');
    return true;
  }
}
