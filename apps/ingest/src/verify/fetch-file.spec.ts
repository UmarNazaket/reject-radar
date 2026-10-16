import { userAgent } from './fetch-file';

describe('userAgent (spec 6.3 rule 5)', () => {
  const original = process.env['INGEST_CONTACT_EMAIL'];

  afterEach(() => {
    if (original === undefined) delete process.env['INGEST_CONTACT_EMAIL'];
    else process.env['INGEST_CONTACT_EMAIL'] = original;
  });

  it('throws when the contact email is not set', () => {
    delete process.env['INGEST_CONTACT_EMAIL'];
    expect(() => userAgent()).toThrow('Set INGEST_CONTACT_EMAIL in .env: every request must carry a contact address (spec §6.3)');
  });

  it('throws when the contact email is blank', () => {
    process.env['INGEST_CONTACT_EMAIL'] = '   ';
    expect(() => userAgent()).toThrow('Set INGEST_CONTACT_EMAIL');
  });

  it('names RejectRadar and includes the trimmed email', () => {
    process.env['INGEST_CONTACT_EMAIL'] = '  owner@example.com ';
    expect(userAgent()).toBe('RejectRadar data verification (owner@example.com)');
  });
});
