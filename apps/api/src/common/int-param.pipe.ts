import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { AppError } from './errors';

const POSITIVE_INTEGER = /^[1-9]\d{0,14}$/;

/** A path id that is not a positive whole number cannot name a row: `404 NOT_FOUND`, like an id that is not there. */
export class PositiveIntParamPipe implements PipeTransform<unknown, number> {
  transform(value: unknown): number {
    if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    return Number(value);
  }
}
