import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';

export const ROLES_KEY = 'auth:roles';

/** Restricts a route to the listed roles. Used by the admin controls. */
export const Roles = (...roles: Array<'USER' | 'ADMIN'>) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Array<'USER' | 'ADMIN'>>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.user || !required.includes(request.user.role)) {
      throw new ForbiddenException('This endpoint requires an administrator account.');
    }
    return true;
  }
}
