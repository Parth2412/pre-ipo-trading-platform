import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Marks a route as reachable without a bearer token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
