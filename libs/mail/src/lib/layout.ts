import { type Locale, textDirection } from '@rejectradar/contracts';
import { translate } from '@rejectradar/i18n';
import { escapeHtml } from './escape';

// Colours and spacing come from the Instant alert email board (docs/design/canvas/Email.dc.html).
export const LAYOUT_COLORS = { page: '#F4F5F7', card: '#FFFFFF', border: '#DADFE6', header: '#0F1A2C', ink: '#121A2B', muted: '#5A6577' } as const;

const BASE_FONTS = "'Public Sans', Arial, sans-serif";

/** Font stack and line height per script: the Nastaliq and Indic scripts need more room than Latin. */
const TYPOGRAPHY: Readonly<Record<Locale, { fontFamily: string; lineHeight: string }>> = {
  en: { fontFamily: BASE_FONTS, lineHeight: '1.5' },
  ur: { fontFamily: `'Noto Nastaliq Urdu', ${BASE_FONTS}`, lineHeight: '2.2' },
  hi: { fontFamily: `'Noto Sans Devanagari', ${BASE_FONTS}`, lineHeight: '1.7' },
  bn: { fontFamily: `'Noto Sans Bengali', ${BASE_FONTS}`, lineHeight: '1.7' },
};

export interface LayoutInput {
  locale: Locale;
  /** The document title (the subject line); plain text, escaped here. */
  title: string;
  /** Trusted HTML for the card body; the caller has escaped every value in it. */
  bodyHtml: string;
}

/**
 * The 600 px account-email layout: a dark header with the wordmark, the body, then the footer. Tables and inline
 * styles only, with no external fonts or images, so it renders the same in every mail client.
 */
export function renderLayout({ locale, title, bodyHtml }: LayoutInput): string {
  const dir = textDirection(locale);
  const { fontFamily, lineHeight } = TYPOGRAPHY[locale];
  const text = `font-family: ${fontFamily}; line-height: ${lineHeight}; text-align: start;`;
  const footer = escapeHtml(translate(locale, 'email.layout.footer'));
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${LAYOUT_COLORS.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="background-color: ${LAYOUT_COLORS.page};">
<tr><td align="center" style="padding: 24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width: 600px; max-width: 100%; background-color: ${LAYOUT_COLORS.card}; border: 1px solid ${LAYOUT_COLORS.border}; border-radius: 8px;">
<tr><td style="padding: 20px 28px; background-color: ${LAYOUT_COLORS.header}; border-radius: 8px 8px 0 0; ${text} font-size: 16px; font-weight: 700; color: #FFFFFF;">RejectRadar</td></tr>
<tr><td style="padding: 28px; ${text} font-size: 15px; color: #3F4A5C;">
${bodyHtml}
</td></tr>
<tr><td style="padding: 18px 28px 24px; border-top: 1px solid ${LAYOUT_COLORS.border}; ${text} font-size: 12.5px; color: ${LAYOUT_COLORS.muted};">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}
