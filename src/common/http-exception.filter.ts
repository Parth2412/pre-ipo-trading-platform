import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode } from './errors';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Normalises every failure into one envelope:
 *
 *   { "error": { "code", "message", "details" }, "path", "timestamp" }
 *
 * Nest's built-in exceptions (validation, 404, throttler) are mapped onto the
 * same `ErrorCode` vocabulary so clients never see two shapes.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = this.toErrorBody(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${body.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    void reply.status(status).send({
      error: body,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private toErrorBody(exception: unknown, status: number): ErrorBody {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null && 'code' in response) {
        const payload = response as ErrorBody;
        return { code: payload.code, message: payload.message, details: payload.details };
      }
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      return {
        code: this.defaultCodeFor(status),
        message: Array.isArray(message) ? message.join('; ') : message,
        details:
          typeof response === 'object' && response !== null && Array.isArray((response as { message?: unknown }).message)
            ? { issues: (response as { message: string[] }).message }
            : undefined,
      };
    }

    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
    };
  }

  private defaultCodeFor(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
