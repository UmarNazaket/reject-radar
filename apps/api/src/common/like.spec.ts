import { escapeLike } from './like';

describe('escapeLike', () => {
  it('escapes the wildcards and the escape character', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
  });

  it('leaves other text alone', () => {
    expect(escapeLike('Basmati rice')).toBe('Basmati rice');
  });
});
