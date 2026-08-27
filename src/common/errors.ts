import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable error codes. Clients switch on `code`, never on the message,
 * so wording can change without breaking integrations.
 */
/**
 * 423 Locked. Nest's `HttpStatus` enum does not expose it, but it is the most
 * accurate code for "this asset exists, trading on it is temporarily suspended".
 */
export const HTTP_STATUS_LOCKED = 423 as HttpStatus;

export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  ASSET_NOT_FOUND = 'ASSET_NOT_FOUND',
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  ORDER_NOT_CANCELLABLE = 'ORDER_NOT_CANCELLABLE',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  INSUFFICIENT_SHARES = 'INSUFFICIENT_SHARES',
  CIRCUIT_BREAKER_TRIPPED = 'CIRCUIT_BREAKER_TRIPPED',
  MARKET_HALTED = 'MARKET_HALTED',
  IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENT_REQUEST_IN_FLIGHT = 'IDEMPOTENT_REQUEST_IN_FLIGHT',
  NO_LIQUIDITY = 'NO_LIQUIDITY',
  PRICE_UNAVAILABLE = 'PRICE_UNAVAILABLE',
  EMAIL_ALREADY_REGISTERED = 'EMAIL_ALREADY_REGISTERED',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface DomainErrorDetails {
  readonly [key: string]: unknown;
}

/** Base class for every error the domain raises deliberately. */
export class DomainException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: DomainErrorDetails,
  ) {
    super({ code, message, details }, status);
  }
}

export class ValidationException extends DomainException {
  constructor(message: string, details?: DomainErrorDetails) {
    super(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}

export class NotFoundException extends DomainException {
  constructor(code: ErrorCode, message: string, details?: DomainErrorDetails) {
    super(code, message, HttpStatus.NOT_FOUND, details);
  }
}

export class InsufficientFundsException extends DomainException {
  constructor(message: string, details?: DomainErrorDetails) {
    super(ErrorCode.INSUFFICIENT_FUNDS, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

export class InsufficientSharesException extends DomainException {
  constructor(message: string, details?: DomainErrorDetails) {
    super(ErrorCode.INSUFFICIENT_SHARES, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

export class CircuitBreakerException extends DomainException {
  constructor(message: string, details?: DomainErrorDetails) {
    // 423 Locked: the asset exists but is temporarily unavailable for trading.
    super(ErrorCode.CIRCUIT_BREAKER_TRIPPED, message, HTTP_STATUS_LOCKED, details);
  }
}

export class MarketHaltedException extends DomainException {
  constructor(message: string, details?: DomainErrorDetails) {
    super(ErrorCode.MARKET_HALTED, message, HTTP_STATUS_LOCKED, details);
  }
}

export class ConflictException extends DomainException {
  constructor(code: ErrorCode, message: string, details?: DomainErrorDetails) {
    super(code, message, HttpStatus.CONFLICT, details);
  }
}

export class UnprocessableException extends DomainException {
  constructor(code: ErrorCode, message: string, details?: DomainErrorDetails) {
    super(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}
