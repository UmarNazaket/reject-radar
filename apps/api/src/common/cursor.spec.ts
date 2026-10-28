import { AppError } from './errors';
import { decodeCursor, decodeTimeCursor, encodeCursor, encodeTimeCursor } from './cursor';

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

describe('time cursor', () => {
  const ID = '019a0000-0000-7000-8000-000000000001';

  it('round-trips a microsecond timestamp and a uuid', () => {
    expect(decodeTimeCursor(encodeTimeCursor('2026-10-28T10:15:30.123456Z', ID))).toEqual({ timestamp: '2026-10-28T10:15:30.123456Z', id: ID });
  });

  it.each([
    '%%%',
    '',
    Buffer.from(`2026-10-28T10:15:30.123Z|${ID}`).toString('base64url'),
    Buffer.from(`2026-13-45T10:15:30.123456Z|${ID}`).toString('base64url'),
    Buffer.from(`2026-02-30T10:15:30.123456Z|${ID}`).toString('base64url'),
    Buffer.from('2026-10-28T10:15:30.123456Z|42').toString('base64url'),
    Buffer.from(`2026-10-28T10:15:30.123456Z|${ID}'; drop table alert;--`).toString('base64url'),
  ])('refuses %j with 400 BAD_REQUEST', (junk) => {
    expect.assertions(2);
    try {
      decodeTimeCursor(junk);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    }
  });
});
