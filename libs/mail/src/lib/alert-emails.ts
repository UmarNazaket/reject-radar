import type { Destination, EventKind, Locale, Severity } from '@rejectradar/contracts';
import { translate } from '@rejectradar/i18n';
import { escapeHtml } from './escape';
import { LAYOUT_COLORS, renderLayout } from './layout';
import { assertHttpUrl, buttonHtml, type RenderedEmail, singleLine, stripAngles } from './render';

/** One alert as an email shows it. Firm names and product text are source data and are never translated. */
export interface AlertEmailItem {
  kind: EventKind;
  severity: Severity;
  /** The event date, `YYYY-MM-DD`. */
  occurredOn: string;
  firmName: string | null;
  productText: string | null;
  destination: Destination;
  /** ISO 3166-1 alpha-2 code of the product's country of origin. */
  originCountry: string | null;
  /** Where the alert opens in the web app; an absolute http(s) URL. */
  url: string | null;
}

interface Links {
  alertsLink: string;
  settingsLink: string;
}

export interface InstantAlertEmailParams extends Links {
  name: string;
  items: AlertEmailItem[];
}

export interface DigestEmailParams extends Links {
  name: string;
  frequency: 'daily' | 'weekly';
  groups: { title: string; items: AlertEmailItem[] }[];
  /** Alerts the digest leaves out; it says how many are waiting in the account. */
  more: number;
}

const LINK_COLOR = '#1F4FCC';
const BODY_COLOR = '#3F4A5C';
const HIGH_COLOR = '#B42318';

const dateFormatters = new Map<Locale, Intl.DateTimeFormat>();

/** `Oct 20, 2026` in the reader's language, with Latin digits, from the UTC calendar day. */
function formatDate(locale: Locale, occurredOn: string): string {
  let formatter = dateFormatters.get(locale);
  if (!formatter) dateFormatters.set(locale, (formatter = new Intl.DateTimeFormat(`${locale}-u-nu-latn`, { dateStyle: 'medium', timeZone: 'UTC' })));
  const date = new Date(`${occurredOn}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? occurredOn : formatter.format(date);
}

/** The country's name in the reader's language; the code itself when the runtime does not know it. */
function countryName(locale: Locale, code: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The lines of one item, as plain strings (not yet escaped). Every value except the catalog texts is source data. */
interface ItemLines {
  label: string;
  firm: string;
  product: string | null;
  meta: string;
  url: string | null;
  viewLabel: string;
}

function itemLines(locale: Locale, item: AlertEmailItem): ItemLines {
  if (item.url !== null) assertHttpUrl('url', item.url);
  const meta = [
    formatDate(locale, item.occurredOn),
    translate(locale, 'email.alertItem.destination', { destination: translate(locale, `taxonomy.destination.${item.destination}`) }),
    ...(item.originCountry ? [translate(locale, 'email.alertItem.origin', { country: countryName(locale, item.originCountry) })] : []),
  ];
  return {
    label: `${translate(locale, `alerts.kind.${item.kind}`)} | ${translate(locale, `email.alertItem.severity.${item.severity}`)}`,
    firm: item.firmName?.trim() || translate(locale, 'email.alertItem.noFirm'),
    product: item.productText?.trim() || null,
    meta: meta.join(' | '),
    url: item.url,
    viewLabel: translate(locale, 'email.alertItem.view'),
  };
}

function itemHtml(lines: ItemLines, high: boolean): string {
  const rows = [
    `<p style="margin: 0 0 4px; font-size: 12.5px; font-weight: 700; color: ${high ? HIGH_COLOR : LAYOUT_COLORS.muted};">${escapeHtml(lines.label)}</p>`,
    `<p style="margin: 0 0 4px; font-size: 16px; font-weight: 700; color: ${LAYOUT_COLORS.ink};">${escapeHtml(lines.firm)}</p>`,
    lines.product ? `<p style="margin: 0 0 4px; color: ${BODY_COLOR};">${escapeHtml(lines.product)}</p>` : '',
    `<p style="margin: 0; font-size: 13px; color: ${LAYOUT_COLORS.muted};">${escapeHtml(lines.meta)}</p>`,
    lines.url
      ? `<p style="margin: 8px 0 0; font-size: 14px; font-weight: 600;"><a href="${escapeHtml(lines.url)}" style="color: ${LINK_COLOR};">${escapeHtml(lines.viewLabel)}</a></p>`
      : '',
  ];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 12px; border: 1px solid ${LAYOUT_COLORS.border}; border-radius: 6px;"><tr><td style="padding: 12px 14px;">${rows.filter(Boolean).join('')}</td></tr></table>`;
}

function itemText(lines: ItemLines): string {
  return [`${lines.label}`, lines.firm, ...(lines.product ? [lines.product] : []), lines.meta, ...(lines.url ? [`${lines.viewLabel}: ${lines.url}`] : [])]
    .map(stripAngles)
    .join('\n');
}

function itemsHtml(locale: Locale, items: AlertEmailItem[]): string {
  return items.map((item) => itemHtml(itemLines(locale, item), item.severity === 'high')).join('\n');
}

function footerLinksHtml(locale: Locale, prefix: string, { alertsLink, settingsLink }: Links): string {
  return [
    buttonHtml(alertsLink, translate(locale, `${prefix}.viewAll`)),
    `<p style="margin: 0; font-size: 13.5px;"><a href="${escapeHtml(settingsLink)}" style="color: ${LINK_COLOR};">${escapeHtml(translate(locale, `${prefix}.settings`))}</a></p>`,
  ].join('\n');
}

function assertLinks({ alertsLink, settingsLink }: Links): void {
  assertHttpUrl('alertsLink', alertsLink);
  assertHttpUrl('settingsLink', settingsLink);
}

const heading = (text: string) =>
  `<h1 style="margin: 0 0 12px; font-size: 24px; line-height: 1.25; font-weight: 700; color: ${LAYOUT_COLORS.ink};">${escapeHtml(text)}</h1>`;
const paragraph = (text: string, extra = '') => `<p style="margin: 0 0 20px; color: ${BODY_COLOR};${extra}">${escapeHtml(text)}</p>`;
const note = (text: string) =>
  `<p style="margin: 0 0 24px; padding: 12px 14px; background-color: ${LAYOUT_COLORS.page}; border-radius: 6px; font-size: 13.5px; color: ${BODY_COLOR};">${escapeHtml(text)}</p>`;

/**
 * The instant email for a user's high-severity alerts: one card per alert, the late-publication note for FDA
 * refusals, and links to the alerts and to the email settings. Every value is HTML-escaped; links must be http(s).
 */
export function renderInstantAlertEmail(locale: Locale, p: InstantAlertEmailParams): RenderedEmail {
  if (p.items.length === 0) throw new Error('The instant alert email needs at least one item');
  assertLinks(p);

  const count = p.items.length;
  const subject = singleLine(translate(locale, 'email.instantAlert.subject', { count }));
  const headingText = translate(locale, 'email.instantAlert.heading');
  const intro = (name: string) => translate(locale, 'email.instantAlert.intro', { name, count });
  const lateNote = translate(locale, 'email.instantAlert.lateNote');

  const html = renderLayout({
    locale,
    title: subject,
    bodyHtml: [
      heading(headingText),
      paragraph(intro(p.name)),
      itemsHtml(locale, p.items),
      note(lateNote),
      footerLinksHtml(locale, 'email.instantAlert', p),
    ].join('\n'),
  });

  const text = [
    headingText,
    stripAngles(intro(p.name)),
    ...p.items.map((item) => itemText(itemLines(locale, item))),
    lateNote,
    `${translate(locale, 'email.instantAlert.viewAll')}: ${stripAngles(p.alertsLink)}`,
    `${translate(locale, 'email.instantAlert.settings')}: ${stripAngles(p.settingsLink)}`,
  ];
  return { subject, html, text: `${text.join('\n\n')}\n` };
}

/**
 * The digest: the alerts grouped under titles the caller chose (a firm, a topic), a line saying how many more are
 * waiting when the digest leaves some out, and the same two links as the instant email.
 */
export function renderDigestEmail(locale: Locale, p: DigestEmailParams): RenderedEmail {
  if (!p.groups.some((group) => group.items.length > 0)) throw new Error('The digest needs at least one item');
  if (!Number.isInteger(p.more) || p.more < 0) throw new Error('The digest parameter "more" must be a whole number of zero or more');
  assertLinks(p);

  const groups = p.groups.filter((group) => group.items.length > 0);
  const subject = singleLine(translate(locale, 'email.digest.subject', { frequency: p.frequency }));
  const headingText = translate(locale, 'email.digest.heading', { frequency: p.frequency });
  const intro = (name: string) => translate(locale, 'email.digest.intro', { name, frequency: p.frequency });
  const more = p.more > 0 ? translate(locale, 'email.digest.more', { count: p.more }) : null;

  const html = renderLayout({
    locale,
    title: subject,
    bodyHtml: [
      heading(headingText),
      paragraph(intro(p.name)),
      ...groups.map(
        (group) =>
          `<h2 style="margin: 0 0 10px; font-size: 17px; line-height: 1.3; font-weight: 700; color: ${LAYOUT_COLORS.ink};">${escapeHtml(group.title)}</h2>\n${itemsHtml(locale, group.items)}`,
      ),
      more ? note(more) : '',
      footerLinksHtml(locale, 'email.digest', p),
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const text = [
    headingText,
    stripAngles(intro(p.name)),
    ...groups.map((group) => [stripAngles(group.title), ...group.items.map((item) => itemText(itemLines(locale, item)))].join('\n\n')),
    ...(more ? [more] : []),
    `${translate(locale, 'email.digest.viewAll')}: ${stripAngles(p.alertsLink)}`,
    `${translate(locale, 'email.digest.settings')}: ${stripAngles(p.settingsLink)}`,
  ];
  return { subject, html, text: `${text.join('\n\n')}\n` };
}
