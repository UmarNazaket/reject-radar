import { TestBed } from '@angular/core/testing';
import { I18n } from './i18n';

const CATALOGS: Record<string, Record<string, string>> = {
  en: { 'web.hello': 'Hello, {name}', 'web.count': '{n, plural, one {# alert} other {# alerts}}', 'web.onlyEnglish': 'English only' },
  ur: { 'web.hello': 'سلام، {name}', 'web.count': '{n, plural, one {# الرٹ} other {# الرٹس}}' },
};

describe('I18n', () => {
  let i18n: I18n;

  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn(async (url: string) => {
      const locale = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? '';
      return { ok: true, status: 200, json: async () => CATALOGS[locale] ?? {} } as Response;
    }) as unknown as typeof fetch;
    i18n = TestBed.inject(I18n);
  });

  it('formats messages with their parameters and plurals', async () => {
    await i18n.use('en');
    expect(i18n.t('web.hello', { name: 'Ayesha' })).toBe('Hello, Ayesha');
    expect(i18n.t('web.count', { n: 1 })).toBe('1 alert');
    expect(i18n.t('web.count', { n: 12 })).toBe('12 alerts');
  });

  it('switches language, direction and the stored choice', async () => {
    await i18n.use('ur');
    expect(document.documentElement.lang).toBe('ur');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('rr_locale')).toBe('ur');
    expect(i18n.t('web.hello', { name: 'عائشہ' })).toBe('سلام، عائشہ');
    await i18n.use('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('keeps Latin digits in every language', async () => {
    await i18n.use('ur');
    expect(i18n.t('web.count', { n: 12 })).toBe('12 الرٹس');
  });

  it('falls back to English, then to the key', async () => {
    await i18n.use('ur');
    expect(i18n.t('web.onlyEnglish')).toBe('English only');
    expect(i18n.t('web.missing')).toBe('web.missing');
  });

  it('loads each catalog once', async () => {
    await i18n.use('ur');
    await i18n.use('en');
    await i18n.use('ur');
    expect((global.fetch as jest.Mock).mock.calls.map(([url]) => url)).toEqual(['/i18n/en.json', '/i18n/ur.json']);
  });
});
