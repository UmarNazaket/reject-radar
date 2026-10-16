import { DESTINATIONS, isDestination } from './destinations';
import { DEFAULT_LOCALE, isLocale, LOCALES, pickLocale, textDirection } from './locales';

describe('locales (spec §9.11)', () => {
  it('supports English, Urdu, Hindi and Bengali with English as the default', () => {
    expect(LOCALES).toEqual(['en', 'ur', 'hi', 'bn']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('ur')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });

  it('writes Urdu right to left and the others left to right', () => {
    expect(textDirection('ur')).toBe('rtl');
    expect(textDirection('en')).toBe('ltr');
    expect(textDirection('hi')).toBe('ltr');
    expect(textDirection('bn')).toBe('ltr');
  });

  it.each([
    [['ur-PK', 'en'], 'ur'],
    [['fr-FR', 'hi-IN'], 'hi'],
    [['bn_BD'], 'bn'],
    [['EN-gb'], 'en'],
    [['de'], 'en'],
    [[], 'en'],
  ] as const)('picks %p → %p', (preferred, expected) => {
    expect(pickLocale(preferred)).toBe(expected);
  });
});

describe('destinations', () => {
  it('lists the four border regions in spec §7.1', () => {
    expect(DESTINATIONS).toEqual(['US', 'EU', 'UK', 'AU']);
    expect(isDestination('EU')).toBe(true);
    expect(isDestination('GB')).toBe(false);
  });
});
