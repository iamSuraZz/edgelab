import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ApiException } from './api-error';

/**
 * Validate a body, query or param against a shared zod schema.
 *
 * The shared schema is the ONLY validation — controllers do not re-check by hand, because two
 * places to change is one place to forget. The parsed value is what the handler receives, so
 * defaults and coercions from the schema are already applied.
 *
 * Usage:
 *
 *   @Post()
 *   create(@Body(new ZodPipe(CreateBacktestSchema)) body: CreateBacktest) { … }
 */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // Every issue, not just the first: a form wants to mark all of its bad fields at once, and
    // a caller fixing one error at a time across round trips is a miserable way to find three.
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: issue.code,
    }));

    const where = metadata.type === 'body' ? 'body' : (metadata.type ?? 'request');
    const summary = issues
      .map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`))
      .join('; ');

    throw ApiException.validation(`Invalid ${where} — ${summary}`, { issues });
  }
}

/** Convenience for the common case of a body. */
export function zodBody<T>(schema: ZodType<T>): ZodPipe<T> {
  return new ZodPipe(schema);
}
