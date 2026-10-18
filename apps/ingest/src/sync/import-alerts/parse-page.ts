import type { AlertList } from '@rejectradar/contracts';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { countryFromName } from '../../core/country';
import { blockText, collapse, usDateToIso, type Selection } from './html-text';

/** The page no longer looks the way the parser expects; `sample` is the HTML, kept for diagnosis. */
export class PageStructureError extends Error {
  constructor(
    message: string,
    readonly sample: string,
  ) {
    super(message);
    this.name = 'PageStructureError';
  }
}

export interface ParsedListingProduct {
  productCode: string | null;
  industryCode: string | null;
  productName: string | null;
  description: string | null;
  listedOn: string | null;
  notes: string | null;
  problems: string[];
}

export interface ParsedListing {
  list: AlertList;
  firmName: string;
  addressRaw: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  countryName: string;
  listedOn: string | null;
  products: ParsedListingProduct[];
}

export interface ParsedAlert {
  number: string;
  title: string;
  alertType: string | null;
  publishedOn: string | null;
  reasonText: string | null;
  guidanceText: string | null;
  productText: string | null;
  chargeText: string | null;
  textSha256: string;
  listings: ParsedListing[];
}

const NOTES_MAX = 1000;
const ALERT_NUMBER = /\d{2}-\d+/;

const stripQuotes = (value: string): string => value.replace(/^["“”\s]+|["“”\s]+$/g, '');
const afterLabel = (text: string, label: RegExp): string => collapse(text.replace(label, ''));

/** The last address part minus the country is the region; the part before it is the city. */
function splitAddress(addressRaw: string | null, countryName: string): { city: string | null; region: string | null } {
  const parts = (addressRaw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return { city: null, region: null };
  const last = parts[parts.length - 1];
  const name = countryName.toLowerCase();
  const endsWithCountry =
    name !== '' &&
    last.toLowerCase().endsWith(name) &&
    (last.length === name.length || /\s/.test(last[last.length - name.length - 1]));
  const region = endsWithCountry ? last.slice(0, last.length - name.length).trim() : last;
  return { region: region === '' ? null : region, city: parts.length >= 2 ? parts[parts.length - 2] : null };
}

/** The `<h3>` whose heading starts with `heading`. */
function sectionHeading($: cheerio.CheerioAPI, heading: string): Selection {
  return $('h3')
    .filter((_, el) => collapse($(el).text()).toLowerCase().startsWith(heading.toLowerCase()))
    .first();
}

/** Text of the `<div>` that follows the `<h3>` whose heading starts with `heading`. */
function sectionText($: cheerio.CheerioAPI, heading: string): string | null {
  const h3 = sectionHeading($, heading);
  return h3.length === 0 ? null : blockText(h3.next('div'));
}

/** Value of a header line such as `<div><B>Type:</B> DWPE</div>`, or null when the line is absent. */
function headerValue($: cheerio.CheerioAPI, label: string): string | null {
  const bold = $('b')
    .filter((_, el) => collapse($(el).text()).replace(/:$/, '').toLowerCase() === label.toLowerCase())
    .first();
  if (bold.length === 0) return null;
  const value = collapse(bold.parent().text())
    .slice(collapse(bold.text()).length)
    .replace(/^[\s:]+/, '');
  return value === '' ? null : value;
}

function parseProduct(el: Selection): ParsedListingProduct {
  const left = el.children('div.floatleft').first();
  const em = left.children('em').first();
  const productCode = em.text().replace(/\s+/g, '');
  const name = collapse(left.text().replace(em.text(), ''));
  return {
    productCode: productCode === '' ? null : productCode,
    industryCode: /^\d{2}/.exec(productCode)?.[0] ?? null,
    productName: name === '' ? null : name,
    description: null,
    listedOn: usDateToIso(el.children('div.floatright').first().text()),
    notes: null,
    problems: [],
  };
}

/**
 * Parses one Import Alert page into its text sections and Red/Green List firms. Throws
 * `PageStructureError` rather than return a partial result when the layout is not what it expects.
 */
export function parseAlertPage(html: string, url: string): ParsedAlert {
  const $ = cheerio.load(html);
  const fail = (message: string): never => {
    throw new PageStructureError(`${url}: ${message}`, html);
  };

  const headingNumber = ALERT_NUMBER.exec($('h1').first().text())?.[0];
  const numberLine = headerValue($, 'Import Alert');
  const number = numberLine ? ALERT_NUMBER.exec(numberLine)?.[0] : undefined;
  if (!headingNumber || !number) return fail('no alert number in the heading or the header line');
  if (headingNumber !== number) return fail(`alert number ${number} does not match the heading ${headingNumber}`);

  const nameHeading = sectionHeading($, 'Import Alert Name');
  const titleText = sectionText($, 'Import Alert Name');
  if (nameHeading.length === 0 || !titleText) return fail('no "Import Alert Name" section');
  const title = stripQuotes(collapse(titleText));
  const reasonText = sectionText($, 'Reason for Alert');
  const guidanceText = sectionText($, 'Guidance');
  const productText = sectionText($, 'Product Description');
  const chargeText = sectionText($, 'Charge');

  const listings: ParsedListing[] = [];
  let list: AlertList | null = null;
  let country: string | null = null;
  let listing: ParsedListing | null = null;
  let product: ParsedListingProduct | null = null;
  let problemsText: string | null = null;
  const closeProduct = () => {
    if (product && problemsText) {
      product.notes = [product.notes, problemsText].filter(Boolean).join(' | ').slice(0, NOTES_MAX);
    }
    product = null;
    problemsText = null;
  };

  // The header sections, country headings, firm blocks and products are all siblings of one container.
  for (const node of nameHeading.parent().children().toArray()) {
    const el = $(node);
    const isRed = el.find('a[name="RedFirm"]').length > 0;
    if (isRed || el.find('a[name="GreenFirm"]').length > 0) {
      closeProduct();
      list = isRed ? 'red' : 'green';
      listing = null;
      continue;
    }
    if (el.is('div.center')) {
      const heading = el.children('h4').first();
      if (heading.length > 0) {
        closeProduct();
        country = collapse(heading.text());
        listing = null;
      }
      continue;
    }
    if (el.is('div.div-info')) {
      closeProduct();
      listing = null;
      if (list === null) {
        return fail('firm blocks found but no a[name=RedFirm] or a[name=GreenFirm] list anchor precedes them');
      }
      if (country === null) return fail('firm block found before any country heading');
      const firmName = collapse(el.find('div.div-name.floatleft').first().text());
      if (firmName === '') continue; // the firm count check below reports the loss
      const addressText = collapse(el.children('div.clear').first().text());
      const addressRaw = addressText === '' ? null : addressText;
      listing = {
        list,
        firmName,
        addressRaw,
        ...splitAddress(addressRaw, country),
        countryCode: countryFromName(country),
        countryName: country,
        listedOn: usDateToIso(el.find('div.div-name.floatright').first().text()),
        products: [],
      };
      listings.push(listing);
      continue;
    }
    if (listing === null || !el.is('div')) continue;
    if (el.children('div.floatleft').length > 0) {
      closeProduct();
      product = parseProduct(el);
      listing.products.push(product);
      continue;
    }
    if (product === null) continue;
    const text = collapse(el.text());
    if (/^desc:/i.test(text)) {
      product.description = afterLabel(text, /^desc:/i) || null;
    } else if (/^notes:/i.test(text)) {
      product.notes = afterLabel(text, /^notes:/i) || null;
    } else if (el.is('div.small') && /^problems:/i.test(text)) {
      problemsText = text;
      product.problems = afterLabel(text, /^problems:/i)
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    }
  }
  closeProduct();

  const firmBlocks = $('div.div-info').length;
  if (firmBlocks !== listings.length) {
    return fail(`the page has ${firmBlocks} firm blocks but ${listings.length} were parsed`);
  }

  const textSha256 = createHash('sha256')
    .update([title, reasonText, guidanceText, productText, chargeText].map((part) => part ?? '').join('\n'))
    .digest('hex');
  return {
    number,
    title,
    alertType: headerValue($, 'Type'),
    publishedOn: usDateToIso(headerValue($, 'Published Date')),
    reasonText,
    guidanceText,
    productText,
    chargeText,
    textSha256,
    listings,
  };
}
