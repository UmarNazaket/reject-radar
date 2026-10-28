import { DESTINATIONS, HAZARD_CATEGORIES, LOCALES } from '@rejectradar/contracts';
import { COMMODITIES, HAZARDS } from '@rejectradar/taxonomy';
import { IntlMessageFormat } from 'intl-messageformat';
import { CATALOGS, CATALOG_STATUS, messageArguments } from './catalogs';

const ENGLISH_KEYS = Object.keys(CATALOGS.en).sort();

describe('catalogs', () => {
  it.each(LOCALES)(
    'every catalog has exactly the English keys (%s)',
    (locale) => {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(ENGLISH_KEYS);
    },
  );

  it.each(LOCALES)('every message parses (%s)', (locale) => {
    const unparsable = Object.entries(CATALOGS[locale]).filter(
      ([, message]) => {
        try {
          new IntlMessageFormat(message, locale);
          return false;
        } catch {
          return true;
        }
      },
    );
    expect(unparsable.map(([key]) => key)).toEqual([]);
  });

  it.each(LOCALES)('translations use the English arguments (%s)', (locale) => {
    for (const key of ENGLISH_KEYS) {
      expect({ key, args: messageArguments(CATALOGS[locale][key]) }).toEqual({
        key,
        args: messageArguments(CATALOGS.en[key]),
      });
    }
  });

  it('every seeded commodity and hazard has an English label', () => {
    const keys = [
      ...COMMODITIES.map((c) => `taxonomy.commodity.${c.slug}`),
      ...HAZARDS.map((h) => `taxonomy.hazard.${h.slug}`),
      ...HAZARD_CATEGORIES.map((c) => `taxonomy.hazardCategory.${c}`),
      ...DESTINATIONS.map((d) => `taxonomy.destination.${d}`),
    ];
    expect(new Set(HAZARDS.map((h) => h.category))).toEqual(new Set(HAZARD_CATEGORIES));
    for (const key of keys) expect({ key, label: CATALOGS.en[key] }).toEqual({ key, label: expect.any(String) });
  });

  it('only English is written by hand', () => {
    expect(CATALOG_STATUS).toEqual({
      en: 'written',
      ur: 'machine-draft',
      hi: 'machine-draft',
      bn: 'machine-draft',
    });
  });

  it('no banned words in English', () => {
    for (const [key, message] of Object.entries(CATALOGS.en)) {
      expect({
        key,
        banned: /\b(clean|safe|banned|blacklisted|unsafe|fraud)\b/i.test(
          message,
        ),
      }).toEqual({
        key,
        banned: false,
      });
    }
  });

  it('keeps RejectRadar in Latin script wherever English names it', () => {
    for (const locale of LOCALES) {
      for (const key of ENGLISH_KEYS) {
        if (CATALOGS.en[key].includes('RejectRadar'))
          expect(CATALOGS[locale][key]).toContain('RejectRadar');
      }
    }
  });

  it('has an error message for every code the API can answer with', () => {
    const codes = [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'UNPROCESSABLE',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      'HTTP_ERROR',
      'INTERNAL',
      'DB_UNAVAILABLE',
      'CSRF_MISSING',
      'INVALID_CREDENTIALS',
      'INVALID_TOKEN',
      'INVALID_SESSION',
      'REFRESH_RACE',
      'EMAIL_CAP_REACHED',
      'COMMON_PASSWORD',
      'EMAIL_NOT_VERIFIED',
      'NO_MEMBERSHIP',
      'ACCOUNT_DEACTIVATED',
      'LAST_OWNER',
      'ALREADY_MEMBER',
      'ALREADY_IN_ACCOUNT',
    ];
    for (const code of codes)
      expect(CATALOGS.en[`errors.${code}`]).toEqual(expect.any(String));
  });

  it('does not reveal whether an email exists', () => {
    expect(CATALOGS.en['errors.INVALID_CREDENTIALS']).not.toMatch(
      /no account|not found|does not exist|unknown/i,
    );
  });
});

describe('messageArguments', () => {
  it('returns sorted, de-duplicated argument names including nested ones', () => {
    expect(
      messageArguments(
        'Hi {name}, {name}! {n, plural, one {# item for {orgName}} other {# items}}',
      ),
    ).toEqual(['n', 'name', 'orgName']);
  });

  it('returns an empty list for plain text', () => {
    expect(messageArguments('Plain text')).toEqual([]);
  });
});
