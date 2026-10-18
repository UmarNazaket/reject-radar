import * as cheerio from 'cheerio';
import { collapse, usDateToIso } from './html-text';

export interface AlertIndexEntry {
  number: string;
  alertType: string;
  publishedOn: string | null;
  title: string;
  url: string;
}

/** Straight and curly quotes around the title are page decoration, not part of the title. */
const stripQuotes = (value: string): string => value.replace(/^["“”\s]+|["“”\s]+$/g, '');

/** Rows of the "Import Alerts by Number" table: number, type, published date, linked title. */
export function parseAlertIndex(html: string, baseUrl: string): AlertIndexEntry[] {
  const $ = cheerio.load(html);
  const entries: AlertIndexEntry[] = [];
  $('tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length < 4) return;
    const number = collapse(cells.eq(0).text());
    if (!/^\d{2}-\d+$/.test(number)) return;
    const href = cells.eq(3).find('a').first().attr('href');
    const title = stripQuotes(collapse(cells.eq(3).text()));
    if (!href || title === '') return;
    entries.push({
      number,
      alertType: collapse(cells.eq(1).text()),
      publishedOn: usDateToIso(cells.eq(2).text()),
      title,
      url: new URL(href, baseUrl).href,
    });
  });
  return entries;
}

/** P2-D9: alert number prefix is the FDA industry code. */
export function isFoodAlert(entry: Pick<AlertIndexEntry, 'number' | 'title'>): boolean {
  const industry = Number.parseInt(entry.number.split('-')[0], 10);
  if (Number.isNaN(industry)) return false;
  if ((industry >= 2 && industry <= 52) || industry === 54 || (industry >= 69 && industry <= 72)) return true;
  return industry === 99 && !/drug|device|cosmetic|tobacco|radiation/i.test(entry.title);
}
