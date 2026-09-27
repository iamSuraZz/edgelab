import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiError, ApiErrorCode } from '@edgelab/shared';

/**
 * Every failure the API reports deliberately, as one exception type carrying the shared
 * `{ code, message, details }` envelope.
 *
 * Nest's built-in `BadRequestException` and friends are deliberately not used: they produce
 * `{ statusCode, message, error }`, a different shape from the one the client validates
 * against, and their default messages ("Bad Request") say nothing about what actually went
 * wrong. The whole point of the envelope is that `message` names the REAL reason.
 */
export class ApiException extends HttpException {
  constructor(
    readonly apiError: ApiError,
    status: HttpStatus,
  ) {
    super(apiError, status);
  }

  static validation(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'validation-failed', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.BAD_REQUEST,
    );
  }

  static notFound(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'not-found', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.NOT_FOUND,
    );
  }

  static conflict(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'conflict', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.CONFLICT,
    );
  }

  /**
   * The range asked for has no stored bars.
   *
   * 404 rather than 400: the request was well formed, the data simply is not here yet. The
   * distinction matters because the fix is "download it", not "fix your request".
   */
  static noData(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'no-data', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.NOT_FOUND,
    );
  }

  static compileFailed(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'compile-failed', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static currencyMismatch(message: string): ApiException {
    return new ApiException(
      { code: 'currency-mismatch', message },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static providerUnavailable(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'provider-unavailable', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  static notCancellable(message: string): ApiException {
    return new ApiException({ code: 'job-not-cancellable', message }, HttpStatus.CONFLICT);
  }

  static unsupported(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'unsupported', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static internal(message: string, details?: unknown): ApiException {
    return new ApiException(
      { code: 'internal', message, ...(details === undefined ? {} : { details }) },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

/** Map a worker-reported error code onto the API's vocabulary. */
export function apiErrorCodeFromJob(code: string | null | undefined): ApiErrorCode {
  switch (code) {
    case 'no-data':
      return 'no-data';
    case 'currency-mismatch':
      return 'currency-mismatch';
    case 'validation-failed':
      return 'validation-failed';
    case 'provider-unavailable':
      return 'provider-unavailable';
    case 'unsupported':
    case 'task-timeout':
    case 'task-out-of-memory':
      return 'unsupported';
    default:
      return 'internal';
  }
}
