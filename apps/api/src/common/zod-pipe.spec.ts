import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from './errors';
import { ZodValidationPipe } from './zod-pipe';

const schema = z.object({
  email: z.email(),
  age: z.number().optional(),
  tags: z.array(z.object({ name: z.string() })).optional(),
});

function failure(value: unknown): AppError {
  try {
    new ZodValidationPipe(schema).transform(value);
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the pipe to throw');
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value', () => {
    expect(new ZodValidationPipe(schema).transform({ email: 'a@example.com', extra: 1 })).toEqual({ email: 'a@example.com' });
  });

  it('throws a 400 BAD_REQUEST AppError that names the failing field', () => {
    const error = failure({ email: 'not-an-email' });
    expect(error).toBeInstanceOf(AppError);
    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Request is not valid');
    const issues = (error.details as { issues: { path: string; message: string }[] }).issues;
    expect(issues[0].path).toBe('email');
    expect(typeof issues[0].message).toBe('string');
  });

  it('writes nested paths with dots', () => {
    const issues = (failure({ email: 'a@example.com', tags: [{ name: 1 }] }).details as { issues: { path: string }[] }).issues;
    expect(issues[0].path).toBe('tags.0.name');
  });

  it('reports a body that is not an object', () => {
    expect(failure(undefined).code).toBe('BAD_REQUEST');
  });
});
