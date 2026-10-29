/** First characters that make a spreadsheet read a cell as a formula (P5-D16). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** The delimiters a CSV is written with: `,`, or `;` for a spreadsheet in a comma-decimal locale (P6-D9). */
export type CsvDelimiter = ',' | ';';

/**
 * One CSV cell: RFC 4180 quoting, and the P5-D16 guard against formula injection. A text that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet shows it as text instead of running it.
 * Numbers are written as they are: a negative number is a number, not a formula. A text holding a quote, a line break or
 * the `delimiter` is quoted.
 */
export function toCsvCell(cell: string | number | null, delimiter: CsvDelimiter = ','): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return String(cell);
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV row, without a line ending, its cells separated by `delimiter`. P6's bulk export reuses it. */
export function toCsvRow(cells: readonly (string | number | null)[], delimiter: CsvDelimiter = ','): string {
  return cells.map((cell) => toCsvCell(cell, delimiter)).join(delimiter);
}
