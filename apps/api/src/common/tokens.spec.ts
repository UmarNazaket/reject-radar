import { randomToken, sha256Hex } from './tokens';

describe('randomToken', () => {
  it('is 32 random bytes as 43 base64url characters', () => {
    const token = randomToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('differs on every call', () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('sha256Hex', () => {
  it('matches the SHA-256 test vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
