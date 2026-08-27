import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { DomainException, ErrorCode } from '../common/errors';
import { HttpStatus } from '@nestjs/common';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

/**
 * Extracts and validates the `Idempotency-Key` header.
 *
 * Required rather than optional: order placement is the one endpoint where a
 * network retry can cost real money, so the client is made to declare intent.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const raw = request.headers[IDEMPOTENCY_HEADER];
    const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (!key) {
      throw new DomainException(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key header is required to place an order. Send a unique value (a UUID is ideal) per order.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return key;
  },
);
