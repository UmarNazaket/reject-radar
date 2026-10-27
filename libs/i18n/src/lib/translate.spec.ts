import { CATALOGS } from './catalogs';
import { MissingTranslationError, translate } from './translate';

describe('translate', () => {
  it('formats parameters', () => {
    expect(
      translate('en', 'email.invite.subject', {
        inviterName: 'Sara',
        orgName: 'Zarfeen',
      }),
    ).toBe('Sara invited you to Zarfeen on RejectRadar');
  });

  it('returns the Urdu text', () => {
    expect(translate('ur', 'email.verify.subject')).toBe(
      CATALOGS.ur['email.verify.subject'],
    );
  });

  it('uses Latin digits in Bengali', () => {
    const catalogs = {
      ...CATALOGS,
      bn: { ...CATALOGS.bn, 'test.number': '{n, number}' },
    };
    const text = translate('bn', 'test.number', { n: 12345 }, catalogs);
    expect(text).toMatch(/^12,345$/);
    expect(text).not.toMatch(/[০-৯]/);
  });

  it('falls back to English for a key missing in one locale', () => {
    const hindi = Object.fromEntries(
      Object.entries(CATALOGS.hi).filter(([key]) => key !== 'role.owner'),
    );
    expect(
      translate('hi', 'role.owner', undefined, { ...CATALOGS, hi: hindi }),
    ).toBe(CATALOGS.en['role.owner']);
  });

  it('throws MissingTranslationError for a key missing in English', () => {
    expect(() => translate('en', 'no.such.key')).toThrow(
      MissingTranslationError,
    );
    expect(() => translate('ur', 'no.such.key')).toThrow(
      MissingTranslationError,
    );
  });
});
