/**
 * RFC 4180 text: a header row of `columns`, then each row's fields in that order, every line ended by "\n". A field
 * that holds a comma, a double quote or a line break is quoted, its double quotes doubled.
 */
export function toCsv<C extends string>(columns: readonly C[], rows: readonly Readonly<Record<C, string>>[]): string {
  const line = (fields: readonly string[]) => `${fields.map(csvField).join(',')}\n`;
  return line(columns) + rows.map((row) => line(columns.map((column) => row[column]))).join('');
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
