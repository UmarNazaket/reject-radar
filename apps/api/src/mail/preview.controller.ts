import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Res,
} from '@nestjs/common';
import { type ApiEnv, isLocale, LOCALES } from '@rejectradar/contracts';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { AppError } from '../common/errors';
import { API_ENV } from '../config/env';
import { renderEmail, type TemplateName } from './templates/render';

const TEMPLATE_NAMES: readonly TemplateName[] = [
  'verify',
  'reset',
  'invite',
  'account_exists',
];

/** The path each template's button opens in the web app. */
const LINK_PATHS: Readonly<Record<TemplateName, string>> = {
  verify: '/verify?token=preview',
  reset: '/reset?token=preview',
  invite: '/invite/preview',
  account_exists: '/login',
};

const HTML = 'text/html; charset=utf-8';

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
    const { html } = renderEmail(name, locale, {
      name: 'Sara Malik',
      orgName: 'Zarfeen Rice Mills',
      inviterName: 'Ayesha Khan',
      role: 'member',
      link: `${origin}${LINK_PATHS[name]}`,
      resetLink: `${origin}/forgot`,
    });
    res.setHeader('Content-Type', HTML);
    return html;
  }
}
