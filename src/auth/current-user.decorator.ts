import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthenticatedUser } from './auth.types';

/** Injects the authenticated principal established by `JwtAuthGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route that is not behind JwtAuthGuard');
    }
    return request.user;
  },
);
