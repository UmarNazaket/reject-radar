import { HttpStatus, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from './errors';

/** Validates a body, query or param against a zod schema and passes on the parsed value (unknown keys stripped). */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'Request is not valid', {
      issues: result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    });
  }
}
