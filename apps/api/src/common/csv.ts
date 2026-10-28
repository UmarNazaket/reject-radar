/** First characters that make a spreadsheet read a cell as a formula (P5-D16). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: RFC 4180 quoting, and the P5-D16 guard against formula injection. A text that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet shows it as text instead of running it.
 * Numbers are written as they are: a negative number is a number, not a formula.
 */
export function toCsvCell(cell: string | number | null): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return String(cell);
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV row, without a line ending. P6's bulk export reuses it. */
export function toCsvRow(cells: readonly (string | number | null)[]): string {
  return cells.map(toCsvCell).join(',');
}
