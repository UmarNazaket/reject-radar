import { emailSchema, passwordSchema, patchMeRequest, signupRequest } from './accounts';

describe('account contracts', () => {
  it('trims and lowercases an email', () => {
    expect(emailSchema.parse(' Ayesha.Khan@Example.COM ')).toBe('ayesha.khan@example.com');
  });

  it('rejects text that is not an email', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('rejects a 257-character password and a 9-character one', () => {
    expect(passwordSchema.safeParse('a'.repeat(257)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(9)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(10)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(256)).success).toBe(true);
  });

  it('requires at least one field to change on the profile', () => {
    expect(patchMeRequest.safeParse({}).success).toBe(false);
    expect(patchMeRequest.safeParse({ name: 'Sara' }).success).toBe(true);
    expect(patchMeRequest.safeParse({ locale: 'ur' }).success).toBe(true);
  });

  it('only accepts a supported language at sign-up', () => {
    const body = { name: 'Sara', email: 'a@example.com', password: 'zarfeen-rice-2026', companyName: 'Zarfeen', locale: 'fr' };
    expect(signupRequest.safeParse(body).success).toBe(false);
    expect(signupRequest.safeParse({ ...body, locale: 'ur' }).success).toBe(true);
  });
});
