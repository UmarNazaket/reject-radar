import { LOCALES } from '@rejectradar/contracts';
import { translate } from '@rejectradar/i18n';
import { escapeHtml } from './escape';
import { renderEmail, type TemplateName } from './render';

const TEMPLATES: readonly TemplateName[] = ['verify', 'reset', 'invite', 'account_exists'];
const PARAMS = { name: 'Sara', link: 'https://app.test/verify?token=t&x=1', inviterName: 'Ayesha', orgName: 'Indus Agro', role: 'admin' };

describe('renderEmail', () => {
  it('renders Urdu right to left with the link', () => {
    const { html } = renderEmail('verify', 'ur', { name: 'Sara', link: 'https://app.test/verify?token=t' });
    expect(html).toContain('<html lang="ur" dir="rtl">');
    expect(html).toContain('https://app.test/verify?token=t');
    expect(html).toContain('Noto Nastaliq Urdu');
  });

  it('renders English left to right', () => {
    expect(renderEmail('verify', 'en', PARAMS).html).toContain('dir="ltr"');
  });

  it('uses the Devanagari and Bengali font stacks for Hindi and Bengali', () => {
    expect(renderEmail('verify', 'hi', PARAMS).html).toContain('Noto Sans Devanagari');
    expect(renderEmail('verify', 'bn', PARAMS).html).toContain('Noto Sans Bengali');
  });

  it('escapes every parameter', () => {
    const { html } = renderEmail('verify', 'en', { ...PARAMS, name: '<script>x</script>' });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes the invite parameters and the link attribute', () => {
    const { html } = renderEmail('invite', 'en', { ...PARAMS, orgName: '"><img src=x>', link: 'https://app.test/i?a="b"&c=<d>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://app.test/i?a=&quot;b&quot;&amp;c=&lt;d&gt;"');
  });

  it('keeps the text version free of markup', () => {
    for (const locale of LOCALES) {
      const { text } = renderEmail('invite', locale, { ...PARAMS, orgName: 'A & B <Co>' });
      expect(text).not.toContain('<');
      expect(text).toContain(PARAMS.link);
    }
  });

  it('leaves & and quotes in the text version unescaped', () => {
    const { text } = renderEmail('verify', 'en', { ...PARAMS, name: 'Tom & "Jerry"' });
    expect(text).toContain('Tom & "Jerry"');
    expect(text).not.toContain('&amp;');
  });

  it('takes the subject from the catalog', () => {
    for (const locale of LOCALES) {
      expect(renderEmail('verify', locale, PARAMS).subject).toBe(translate(locale, 'email.verify.subject'));
    }
    expect(renderEmail('invite', 'en', PARAMS).subject).toBe('Ayesha invited you to Indus Agro on RejectRadar');
  });

  it('names the invited role in the language of the email', () => {
    expect(renderEmail('invite', 'en', PARAMS).text).toContain('as Admin.');
    expect(renderEmail('invite', 'ur', PARAMS).text).toContain(translate('ur', 'role.admin'));
  });

  it('refuses a missing parameter and a link that is not http(s)', () => {
    expect(() => renderEmail('verify', 'en', { link: PARAMS.link })).toThrow('name');
    expect(() => renderEmail('verify', 'en', { name: 'Sara', link: 'javascript:alert(1)' })).toThrow('http(s)');
    expect(() => renderEmail('verify', 'en', { name: 'Sara', link: 'not a url' })).toThrow('not a URL');
  });

  it('keeps the subject on one line and unescaped', () => {
    const { subject } = renderEmail('invite', 'en', { ...PARAMS, inviterName: 'A & B\r\nBcc: x@y.z' });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('A & B');
  });

  it('renders every template in every locale', () => {
    for (const template of TEMPLATES) {
      for (const locale of LOCALES) {
        const email = renderEmail(template, locale, PARAMS);
        expect(email.subject).not.toBe('');
        expect(email.html).toContain(`<html lang="${locale}"`);
        expect(email.html).toContain(translate(locale, 'email.layout.footer'));
        expect(email.text).toContain(PARAMS.link);
      }
    }
  });

  it('does not load external fonts or images', () => {
    const { html } = renderEmail('reset', 'en', PARAMS);
    expect(html).not.toMatch(/<link|@import|<img|url\(/i);
  });

  it('shows the login and reset links of the account-exists email', () => {
    const { html, text } = renderEmail('account_exists', 'en', { ...PARAMS, resetLink: 'https://app.test/forgot' });
    expect(html).toContain('https://app.test/forgot');
    expect(text).toContain('https://app.test/forgot');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
