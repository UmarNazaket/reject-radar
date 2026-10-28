import { EVENT_KINDS, LOCALES, type Locale } from '@rejectradar/contracts';
import { CATALOGS, translate } from '@rejectradar/i18n';
import { type AlertEmailItem, renderDigestEmail, renderInstantAlertEmail } from './alert-emails';

const ITEMS: AlertEmailItem[] = [
  {
    kind: 'fda_refusal',
    severity: 'high',
    occurredOn: '2026-10-20',
    firmName: 'Zarfeen Rice Mills <Pvt>',
    productText: 'Basmati Rice <b>',
    destination: 'US',
    originCountry: 'PK',
    url: 'https://app.test/notices/1?a=1&b=2',
  },
  {
    kind: 'import_alert_listed',
    severity: 'high',
    occurredOn: '2026-10-19',
    firmName: 'Indus "Agro" & Co',
    productText: null,
    destination: 'US',
    originCountry: 'PK',
    url: 'https://app.test/notices/2',
  },
  {
    kind: 'rasff_notification',
    severity: 'normal',
    occurredOn: '2026-10-18',
    firmName: null,
    productText: 'Chilli powder',
    destination: 'EU',
    originCountry: null,
    url: null,
  },
];

const instant = (locale: Locale, items = ITEMS) =>
  renderInstantAlertEmail(locale, { name: 'Sara', items, alertsLink: 'https://app.test/alerts', settingsLink: 'https://app.test/settings' });

const digest = (locale: Locale, frequency: 'daily' | 'weekly' = 'daily') =>
  renderDigestEmail(locale, {
    name: 'Sara',
    frequency,
    groups: [
      { title: 'Zarfeen Rice Mills <Pvt>', items: ITEMS.slice(0, 2) },
      { title: 'Rice from Pakistan to the EU', items: ITEMS.slice(2) },
    ],
    more: 5,
    alertsLink: 'https://app.test/alerts',
    settingsLink: 'https://app.test/settings',
  });

describe('renderInstantAlertEmail', () => {
  it('lists every item', () => {
    const { subject, html, text } = instant('en');
    expect(subject).toBe(translate('en', 'email.instantAlert.subject', { count: 3 }));
    expect(html).toContain('Zarfeen Rice Mills &lt;Pvt&gt;');
    expect(html).toContain('Indus &quot;Agro&quot; &amp; Co');
    expect(html).not.toContain('<Pvt>');
    expect(text).toContain('Zarfeen Rice Mills Pvt');
    expect(text).toContain('Chilli powder');
    expect(text).not.toContain('<');
  });

  it('is right to left in Urdu', () => {
    expect(instant('ur').html).toContain('dir="rtl"');
    expect(instant('en').html).toContain('dir="ltr"');
  });

  it('does not translate source data', () => {
    const { html } = instant('ur');
    expect(html).toContain('Basmati Rice &lt;b&gt;');
    expect(html).toContain('Zarfeen Rice Mills &lt;Pvt&gt;');
  });

  it('carries the late-publication note', () => {
    expect(translate('en', 'email.instantAlert.lateNote')).toBe('FDA can publish a refusal weeks after its date.');
    for (const locale of LOCALES) {
      const { html, text } = instant(locale);
      expect(html).toContain(translate(locale, 'email.instantAlert.lateNote'));
      expect(text).toContain(translate(locale, 'email.instantAlert.lateNote'));
    }
  });

  it('escapes links, keeps them http(s) and shows dates with Latin digits', () => {
    const { html, text } = instant('bn');
    expect(html).toContain('href="https://app.test/notices/1?a=1&amp;b=2"');
    expect(html).toContain('href="https://app.test/alerts"');
    expect(html).toContain('href="https://app.test/settings"');
    expect(text).toContain('https://app.test/notices/1?a=1&b=2');
    expect(html).toContain('2026');
    expect(html).not.toMatch(/[০-৯]/);
    expect(() => instant('en', [{ ...ITEMS[0], url: 'javascript:alert(1)' }])).toThrow('http(s)');
    expect(() =>
      renderInstantAlertEmail('en', { name: 'Sara', items: ITEMS, alertsLink: 'not a url', settingsLink: 'https://app.test/settings' }),
    ).toThrow('not a URL');
  });

  it('escapes the name and keeps the subject on one line', () => {
    const { html, subject } = renderInstantAlertEmail('en', {
      name: '<script>x</script>',
      items: ITEMS,
      alertsLink: 'https://app.test/alerts',
      settingsLink: 'https://app.test/settings',
    });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('refuses an empty list', () => {
    expect(() => instant('en', [])).toThrow('at least one');
  });

  it('renders in every language', () => {
    for (const locale of LOCALES) {
      const email = instant(locale);
      expect(email.subject).toBe(translate(locale, 'email.instantAlert.subject', { count: 3 }));
      expect(email.html).toContain(`<html lang="${locale}"`);
      for (const kind of new Set(ITEMS.map((item) => item.kind))) expect(email.html).toContain(translate(locale, `alerts.kind.${kind}`));
    }
  });
});

describe('renderDigestEmail', () => {
  it.each(LOCALES)('renders the groups and the overflow line (%s)', (locale) => {
    const { html, text, subject } = digest(locale);
    expect(html).toContain('Zarfeen Rice Mills &lt;Pvt&gt;');
    expect(html).toContain('Rice from Pakistan to the EU');
    expect(html).toContain(translate(locale, 'email.digest.more', { count: 5 }));
    expect(text).toContain(translate(locale, 'email.digest.more', { count: 5 }));
    expect(subject).toBe(translate(locale, 'email.digest.subject', { frequency: 'daily' }));
    expect(html).toContain(`<html lang="${locale}"`);
  });

  it('names the frequency and omits the overflow line when nothing is left out', () => {
    expect(digest('en', 'weekly').subject).toBe(translate('en', 'email.digest.subject', { frequency: 'weekly' }));
    expect(digest('en', 'weekly').subject).not.toBe(digest('en', 'daily').subject);
    const none = renderDigestEmail('en', {
      name: 'Sara',
      frequency: 'daily',
      groups: [{ title: 'All', items: ITEMS }],
      more: 0,
      alertsLink: 'https://app.test/alerts',
      settingsLink: 'https://app.test/settings',
    });
    expect(none.html).not.toContain('more alert');
  });

  it('is right to left in Urdu and does not translate source data', () => {
    const { html } = digest('ur');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('Basmati Rice &lt;b&gt;');
  });

  it('refuses a digest with nothing in it', () => {
    expect(() =>
      renderDigestEmail('en', { name: 'Sara', frequency: 'daily', groups: [], more: 0, alertsLink: 'https://app.test/a', settingsLink: 'https://app.test/s' }),
    ).toThrow('at least one');
  });
});

describe('copy', () => {
  const BANNED = /\b(clean|safe|banned|blacklisted|unsafe|fraud)\b/i;

  it('uses none of the banned words in English', () => {
    for (const email of [instant('en'), digest('en'), digest('en', 'weekly')]) {
      expect(email.subject).not.toMatch(BANNED);
      expect(email.text).not.toMatch(BANNED);
    }
    for (const [key, message] of Object.entries(CATALOGS.en)) {
      if (key.startsWith('email.instantAlert.') || key.startsWith('email.digest.') || key.startsWith('alerts.kind.'))
        expect({ key, banned: BANNED.test(message) }).toEqual({ key, banned: false });
    }
  });

  it.each(LOCALES)('has a label for every event kind (%s)', (locale) => {
    for (const kind of EVENT_KINDS) expect({ kind, label: CATALOGS[locale][`alerts.kind.${kind}`] }).toEqual({ kind, label: expect.any(String) });
  });

  it('says "refused entry" for FDA refusals and "Import Alert" for listings', () => {
    expect(CATALOGS.en['alerts.kind.fda_refusal']).toMatch(/refused entry/i);
    expect(CATALOGS.en['alerts.kind.import_alert_listed']).toMatch(/listed on Import Alert/i);
    expect(CATALOGS.en['alerts.kind.import_alert_delisted']).toMatch(/removed from Import Alert/i);
  });
});
