export interface JwtPayload {
  /** User id. */
  sub: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'USER' | 'ADMIN';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}
