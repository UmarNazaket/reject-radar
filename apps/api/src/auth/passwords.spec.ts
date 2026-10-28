import { DUMMY_PASSWORD_HASH, hashPassword, isCommonPassword, verifyPassword } from './passwords';

// argon2id with 19 MiB, 2 passes, 1 lane (spec 12). The library writes the parameters as m, p, t, so compare them by name.
function parameters(hash: string): Record<string, string> {
  const [algorithm, version, params] = hash.split('$').slice(1);
  expect(algorithm).toBe('argon2id');
  expect(version).toBe('v=19');
  return Object.fromEntries(params.split(',').map((pair) => pair.split('=') as [string, string]));
}

describe('hashPassword / verifyPassword', () => {
  it('hashes with argon2id at m=19456, t=2, p=1', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(parameters(hash)).toEqual({ m: '19456', t: '2', p: '1' });
  });

  it('salts every hash', async () => {
    expect(await hashPassword('correct horse battery')).not.toBe(await hashPassword('correct horse battery'));
  });

  it('verifies the same password and rejects a different one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterz')).toBe(false);
  });

  it('answers false, not an error, for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('is a well-formed argon2id hash with the production parameters', () => {
    expect(parameters(DUMMY_PASSWORD_HASH)).toEqual({ m: '19456', t: '2', p: '1' });
  });

  it('matches no password a person would type', async () => {
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, 'correct horse battery')).toBe(false);
  });
});

describe('isCommonPassword', () => {
  it('ignores case', () => {
    expect(isCommonPassword('QWERTYUIOP')).toBe(true);
    expect(isCommonPassword('qwertyuiop')).toBe(true);
    expect(isCommonPassword('Basketball')).toBe(true);
  });

  it('accepts a password that is not in the list', () => {
    expect(isCommonPassword('zarfeen-rice-2026')).toBe(false);
  });
});
