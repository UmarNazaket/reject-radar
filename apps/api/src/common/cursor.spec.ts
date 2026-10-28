import { AppError } from './errors';
import { decodeCursor, encodeCursor } from './cursor';

describe('cursor', () => {
  it('round-trips a date and an id', () => {
    expect(decodeCursor(encodeCursor('2026-10-01', 42))).toEqual({ date: '2026-10-01', id: '42' });
    expect(decodeCursor(encodeCursor('2026-10-01', '9007199254740993'))).toEqual({ date: '2026-10-01', id: '9007199254740993' });
  });

  it('is URL-safe', () => {
    expect(encodeCursor('2026-10-01', 42)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(['%%%', '', 'bm90LWEtY3Vyc29y', Buffer.from('2026-13-45|7').toString('base64url'), Buffer.from('2026-10-01|-1').toString('base64url')])(
    'refuses %j with 400 BAD_REQUEST',
    (junk) => {
      expect.assertions(2);
      try {
        decodeCursor(junk);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
      }
    },
  );
});
