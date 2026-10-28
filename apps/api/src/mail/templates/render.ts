import type { Locale } from '@rejectradar/contracts';
import { translate } from '@rejectradar/i18n';
import { escapeHtml } from './escape';
import { LAYOUT_COLORS, renderLayout } from './layout';

export type TemplateName = 'verify' | 'reset' | 'invite' | 'account_exists';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface TemplateSpec {
  /** Catalog prefix: `email.<prefix>.subject`, `.heading`, `.body`. */
  prefix: string;
  /** Parameters the template cannot render without. */
  required: readonly string[];
  /** Catalog key of the button label, and the expiry line when the link expires. */
  button: string;
  expiry?: string;
}

const TEMPLATES: Readonly<Record<TemplateName, TemplateSpec>> = {
  verify: { prefix: 'verify', required: ['name', 'link'], button: 'email.verify.button', expiry: 'email.verify.expiry' },
  reset: { prefix: 'reset', required: ['name', 'link'], button: 'email.reset.button', expiry: 'email.reset.expiry' },
  invite: {
    prefix: 'invite',
    required: ['inviterName', 'orgName', 'role', 'link'],
    button: 'email.invite.button',
    expiry: 'email.invite.expiry',
  },
  // The login link is the button; a second link (`resetLink`) to reset the password follows it when given.
  account_exists: { prefix: 'accountExists', required: ['link'], button: 'email.accountExists.loginButton' },
};

const ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

function assertHttpUrl(name: string, value: string): void {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error(`Email parameter "${name}" is not a URL`);
  }
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error(`Email parameter "${name}" must be an http(s) URL`);
}

/** The invite names the role in the reader's language when it is one of the account roles. */
function withLocalisedRole(locale: Locale, params: Record<string, string>): Record<string, string> {
  return params['role'] !== undefined && ROLES.has(params['role']) ? { ...params, role: translate(locale, `role.${params['role']}`) } : params;
}

/** Subjects are single-line plain text; a name with a line break must not be able to add a header. */
const singleLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** The plain-text version is not HTML, but it must never contain markup, so angle brackets are dropped. */
const stripAngles = (value: string) => value.replace(/[<>]/g, '');

/**
 * Renders one of the four account emails in `locale`. Every parameter is HTML-escaped in the HTML version; the
 * text version carries them without markup characters. `params.link` is the button's URL.
 */
export function renderEmail(template: TemplateName, locale: Locale, params: Record<string, string>): RenderedEmail {
  const spec = TEMPLATES[template];
  for (const name of spec.required) {
    if (!params[name]) throw new Error(`Email template "${template}" needs the parameter "${name}"`);
  }
  assertHttpUrl('link', params['link']);
  if (params['resetLink'] !== undefined) assertHttpUrl('resetLink', params['resetLink']);

  const values = withLocalisedRole(locale, params);
  const textValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, stripAngles(value)]));
  const t = (key: string, forText = false) => translate(locale, key, forText ? textValues : values);

  const heading = t(`email.${spec.prefix}.heading`);
  const body = t(`email.${spec.prefix}.body`);
  const button = t(spec.button);
  const expiry = spec.expiry ? t(spec.expiry) : null;
  const ignore = t('email.layout.ignore');
  const resetLabel = template === 'account_exists' && params['resetLink'] ? t('email.accountExists.resetButton') : null;

  const html = renderLayout({
    locale,
    title: singleLine(t(`email.${spec.prefix}.subject`)),
    bodyHtml: [
      `<h1 style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 700; color: ${LAYOUT_COLORS.ink};">${escapeHtml(heading)}</h1>`,
      `<p style="margin: 0 0 24px; color: #3F4A5C;">${escapeHtml(body)}</p>`,
      buttonHtml(params['link'], button),
      resetLabel ? `<p style="margin: 0 0 24px; font-size: 14px; font-weight: 600;"><a href="${escapeHtml(params['resetLink'])}" style="color: #1F4FCC;">${escapeHtml(resetLabel)}</a></p>` : '',
      expiry ? `<p style="margin: 0 0 12px; padding: 12px 14px; background-color: ${LAYOUT_COLORS.page}; border-radius: 6px; font-size: 13.5px; color: #3F4A5C;">${escapeHtml(expiry)}</p>` : '',
      `<p style="margin: 0; font-size: 13.5px; color: ${LAYOUT_COLORS.muted};">${escapeHtml(ignore)}</p>`,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const textLines = [
    t(`email.${spec.prefix}.heading`, true),
    t(`email.${spec.prefix}.body`, true),
    `${button}: ${stripAngles(params['link'])}`,
    ...(resetLabel ? [`${resetLabel}: ${stripAngles(params['resetLink'])}`] : []),
    ...(expiry ? [expiry] : []),
    ignore,
  ];

  return { subject: singleLine(t(`email.${spec.prefix}.subject`)), html, text: `${textLines.join('\n\n')}\n` };
}

function buttonHtml(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 24px;"><tr><td style="background-color: #1F4FCC; border-radius: 6px;"><a href="${escapeHtml(href)}" style="display: inline-block; padding: 14px 24px; font-weight: 600; color: #FFFFFF; text-decoration: none;">${escapeHtml(label)}</a></td></tr></table>`;
}
