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

  it('keeps the 4xx status of an exposed body-parser error', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, expose: true, type: 'entity.too.large' });
    const { status, body } = toErrorBody(tooLarge, 'req-5');
    expect(status).toBe(413);
    expect(body).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: 'request entity too large', requestId: 'req-5' });
  });

  it('does not expose a non-exposed error even if it carries a status', () => {
    const { status, body } = toErrorBody(Object.assign(new Error('secret detail'), { status: 500, expose: false }), 'req-6');
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL');
    expect(body.message).not.toContain('secret');
  });
});
