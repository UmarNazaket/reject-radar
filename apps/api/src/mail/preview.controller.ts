import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Res,
} from '@nestjs/common';
import { type ApiEnv, isLocale, LOCALES } from '@rejectradar/contracts';
import { type AlertEmailItem, renderDigestEmail, renderEmail, renderInstantAlertEmail, type TemplateName } from '@rejectradar/mail';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { AppError } from '../common/errors';
import { API_ENV } from '../config/env';

type PreviewName = TemplateName | 'instant_alert' | 'digest';

const TEMPLATE_NAMES: readonly PreviewName[] = [
  'verify',
  'reset',
  'invite',
  'account_exists',
  'payment_failed',
  'dispute_resolved',
  'dispute_rejected',
  'instant_alert',
  'digest',
];

/** The path each template's button opens in the web app. */
const LINK_PATHS: Readonly<Record<TemplateName, string>> = {
  verify: '/verify?token=preview',
  reset: '/reset?token=preview',
  invite: '/invite/preview',
  account_exists: '/login',
  payment_failed: '/settings/billing',
  dispute_resolved: '/firms/1',
  dispute_rejected: '/firms/1',
};

const HTML = 'text/html; charset=utf-8';

/** Fixed sample alerts for the instant and digest previews; the origin is added so the links open the running web app. */
const sampleItems = (origin: string): AlertEmailItem[] => [
  {
    kind: 'fda_refusal',
    severity: 'high',
    occurredOn: '2026-10-20',
    firmName: 'Zarfeen Rice Mills',
    productText: 'Basmati rice, 25 kg bags',
    destination: 'US',
    originCountry: 'PK',
    url: `${origin}/alerts/preview-1`,
  },
  {
    kind: 'import_alert_listed',
    severity: 'high',
    occurredOn: '2026-10-19',
    firmName: 'Indus Agro Exports',
    productText: null,
    destination: 'US',
    originCountry: 'PK',
    url: `${origin}/alerts/preview-2`,
  },
  {
    kind: 'rasff_notification',
    severity: 'normal',
    occurredOn: '2026-10-18',
    firmName: null,
    productText: 'Chilli powder, aflatoxins above the limit',
    destination: 'EU',
    originCountry: 'IN',
    url: `${origin}/alerts/preview-3`,
  },
];

/**
 * Shows every account email in every language, for the person translating or restyling them. It is only registered
 * outside production (P4-D13), and everything it renders is fixed sample text, never a request value.
 */
@Public()
@Controller('dev/emails')
export class EmailPreviewController {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  @Get()
  index(@Res({ passthrough: true }) res: Response): string {
    const items = TEMPLATE_NAMES.flatMap((template) =>
      LOCALES.map(
        (locale) =>
          `<li><a href="/v1/dev/emails/${template}/${locale}">${template} (${locale})</a></li>`,
      ),
    );
    res.setHeader('Content-Type', HTML);
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Email previews</title></head><body><h1>Email previews</h1><ul>\n${items.join('\n')}\n</ul></body></html>\n`;
  }

  // The header is set after validation: an error answers with the API's JSON body, not with HTML.
  @Get(':template/:locale')
  preview(
    @Param('template') template: string,
    @Param('locale') locale: string,
    @Res({ passthrough: true }) res: Response,
  ): string {
    const name = TEMPLATE_NAMES.find((candidate) => candidate === template);
    if (!name || !isLocale(locale))
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'No such email preview',
      );
    const origin = this.env.APP_ORIGIN;
    const links = { alertsLink: `${origin}/alerts`, settingsLink: `${origin}/settings` };
    const items = sampleItems(origin);
    const { html } =
      name === 'instant_alert'
        ? renderInstantAlertEmail(locale, { name: 'Sara Malik', items, ...links })
        : name === 'digest'
          ? renderDigestEmail(locale, {
              name: 'Sara Malik',
              frequency: 'weekly',
              groups: [
                { title: 'Zarfeen Rice Mills', items: items.slice(0, 1) },
                { title: 'Rice and spices from Pakistan', items: items.slice(1) },
              ],
              more: 5,
              ...links,
            })
          : renderEmail(name, locale, {
              name: 'Sara Malik',
              orgName: 'Zarfeen Rice Mills',
              inviterName: 'Ayesha Khan',
              role: 'member',
              link: `${origin}${LINK_PATHS[name]}`,
              resetLink: `${origin}/forgot`,
              firmName: 'Zarfeen Rice Mills',
              note: 'The refusal of 12 March belonged to another firm with a similar name. We moved it there.',
            });
    res.setHeader('Content-Type', HTML);
    return html;
  }
}
