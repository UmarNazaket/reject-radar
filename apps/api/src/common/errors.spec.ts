import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { AppError, toErrorBody } from './errors';

describe('toErrorBody (spec §13)', () => {
  it('uses the code and details of an AppError', () => {
    const { status, body } = toErrorBody(new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED', 'Watchlist is full', { limit: 25 }), 'req-1');
    expect(status).toBe(409);
    expect(body).toEqual({ code: 'LIMIT_REACHED', message: 'Watchlist is full', details: { limit: 25 }, requestId: 'req-1' });
  });

  it('maps a Nest HttpException status to a code', () => {
    const { status, body } = toErrorBody(new NotFoundException('Firm not found'), 'req-2');
    expect(status).toBe(404);
    expect(body).toEqual({ code: 'NOT_FOUND', message: 'Firm not found', requestId: 'req-2' });
  });

  it('joins validation message arrays', () => {
    const { body } = toErrorBody(new BadRequestException(['name is required', 'country is invalid']), 'req-3');
    expect(body.message).toBe('name is required; country is invalid');
  });

  it('hides internal error details behind a generic 500', () => {
    const { status, body } = toErrorBody(new Error('connection string leaked here'), 'req-4');
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL');
    expect(body.message).not.toContain('leaked');
    expect(body).not.toHaveProperty('details');
  });
});
