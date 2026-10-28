import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../common/errors';

const uuid = z.uuid();

/** A path id that is not a UUID cannot name anything in the account: `404 NOT_FOUND`, like an id that is not there. */
export class UuidParamPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = uuid.safeParse(value);
    if (!result.success) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    return result.data;
  }
}
