import type * as cheerio from 'cheerio';

export type Selection = ReturnType<cheerio.CheerioAPI>;

/** Placeholder for a `<br>` while whitespace is collapsed; never appears in real page text. */
const BREAK = '\u0001';

/** Collapses every run of whitespace (including non-breaking spaces and newlines) to one space. */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Text of an element with `<br>` as a line break; never HTML. Null when it is empty. */
export function blockText(el: Selection): string | null {
  const copy = el.clone();
  copy.find('br').replaceWith(BREAK);
  const lines = copy
    .text()
    .replace(/\s+/g, ' ')
    .split(BREAK)
    .map((line) => line.trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text === '' ? null : text;
}

/** `MM/DD/YYYY` (anywhere in the text) as `YYYY-MM-DD`, or null when absent or not a real date. */
export function usDateToIso(value: string | null | undefined): string | null {
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value ?? '');
  if (!match) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
