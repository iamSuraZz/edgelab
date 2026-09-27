import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@edgelab/shared';

import { ApiException } from './api-error';

/**
 * Turns every thrown thing into the shared `{ code, message, details }` envelope, so a client
 * never has to handle two error shapes.
 *
 * An unrecognised exception is reported as `internal` with a generic message and the real one
 * logged server-side. That is not politeness — an unexpected error's message can contain a
 * connection string or a query, and this app's config layer exists specifically to keep
 * credentials out of responses.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<{ method?: string; url?: string }>();

    const { status, body } = this.render(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method ?? '?'} ${request.url ?? '?'} → ${String(status)} ${body.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method ?? '?'} ${request.url ?? '?'} → ${String(status)} ${body.message}`,
      );
    }

    // A streaming response (SSE) may already have sent headers; writing a JSON body then
    // would corrupt the stream. End it instead.
    if (response.headersSent) {
      response.end();
      return;
    }

    response.status(status).json(body);
  }

  private render(exception: unknown): { status: number; body: ApiError } {
    if (exception instanceof ApiException) {
      return { status: exception.getStatus(), body: exception.apiError };
    }

    if (exception instanceof HttpException) {
      // Nest's own exceptions (404 from the router, payload-too-large from body-parser) get
      // translated rather than passed through, so the envelope stays uniform.
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : typeof (raw as { message?: unknown }).message === 'string'
            ? (raw as { message: string }).message
            : exception.message;

      return {
        status,
        body: {
          code: status === HttpStatus.NOT_FOUND ? 'not-found' : 'validation-failed',
          message,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'internal',
        message: 'Something went wrong. Check the API logs for the details.',
      },
    };
  }
}
