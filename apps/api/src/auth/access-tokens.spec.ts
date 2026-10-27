import { JwtService } from '@nestjs/jwt';
import { AccessTokenService, type AccessClaims } from './access-tokens';
import { testEnv } from '../testing/test-app';

const env = testEnv('postgres://rr:rr@localhost:5432/rr');
const CLAIMS: AccessClaims = {
  userId: '0199a000-0000-7000-8000-000000000001',
  orgId: '0199a000-0000-7000-8000-000000000002',
  familyId: '0199a000-0000-7000-8000-000000000003',
};

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('AccessTokenService', () => {
  const jwt = new JwtService();
  const tokens = new AccessTokenService(jwt, env);
  const payload = { sub: CLAIMS.userId, org: CLAIMS.orgId, fam: CLAIMS.familyId };

  it('verifies a signed token to the same claims', () => {
    expect(tokens.verify(tokens.sign(CLAIMS))).toEqual(CLAIMS);
  });

  it('puts sub, org and fam in the payload and lives for 15 minutes', () => {
    const decoded = jwt.decode<Record<string, unknown> & { iat: number; exp: number }>(tokens.sign(CLAIMS));
    expect(decoded).toMatchObject(payload);
    expect(decoded.exp - decoded.iat).toBe(900);
    const header = JSON.parse(Buffer.from(tokens.sign(CLAIMS).split('.')[0], 'base64url').toString()) as object;
    expect(header).toMatchObject({ alg: 'HS256' });
  });

  it('refuses a token signed with another secret', () => {
    const forged = jwt.sign(payload, { secret: 'another-secret-another-secret-another-secret', algorithm: 'HS256', expiresIn: 900 });
    expect(tokens.verify(forged)).toBeNull();
  });

  it('refuses a token that names no algorithm (alg none)', () => {
    const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ ...payload, iat: 1, exp: 4_102_444_800 })}.`;
    expect(tokens.verify(unsigned)).toBeNull();
  });

  it('refuses a token signed with the right secret but another algorithm', () => {
    const hs512 = jwt.sign(payload, { secret: env.JWT_SECRET, algorithm: 'HS512', expiresIn: 900 });
    expect(tokens.verify(hs512)).toBeNull();
  });

  it('refuses a token past its exp', () => {
    const expired = jwt.sign(payload, { secret: env.JWT_SECRET, algorithm: 'HS256', expiresIn: -1 });
    expect(tokens.verify(expired)).toBeNull();
  });

  it('refuses a token whose claims are missing or not strings', () => {
    const noFamily = jwt.sign({ sub: CLAIMS.userId, org: CLAIMS.orgId }, { secret: env.JWT_SECRET, algorithm: 'HS256', expiresIn: 900 });
    const numeric = jwt.sign({ ...payload, org: 7 }, { secret: env.JWT_SECRET, algorithm: 'HS256', expiresIn: 900 });
    expect(tokens.verify(noFamily)).toBeNull();
    expect(tokens.verify(numeric)).toBeNull();
  });

  it.each(['', 'not-a-token', 'a.b.c', 'a.b'])('returns null instead of throwing for %p', (garbage) => {
    expect(tokens.verify(garbage)).toBeNull();
  });
});
