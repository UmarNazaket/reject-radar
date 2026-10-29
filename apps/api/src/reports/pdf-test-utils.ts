/**
 * Helpers for specs of PDF output. pdfmake embeds subset TrueType fonts, so the text of a rendered PDF is glyph-encoded
 * and cannot be searched in its bytes: content is asserted on the document definition, and only the page count on the file.
 */

/** Every string in a document definition (text nodes, table cells, list items), in document order. */
export function textOf(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (typeof node === 'object' && node !== null) return Object.values(node).flatMap(textOf);
  return [];
}

/** The pages of an uncompressed PDF: `/Type /Page` objects, not the `/Type /Pages` tree that also matches a plain substring. */
export function pageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
}

/** A table body as pdfmake takes it: rows of cells, each a string or a node with `text`. */
export type TableBody = unknown[][];

/** Every table body in a document definition (a table inside a table is found too), in document order. */
export function tableBodies(node: unknown): TableBody[] {
  if (Array.isArray(node)) return node.flatMap(tableBodies);
  if (typeof node !== 'object' || node === null) return [];
  const table = (node as { table?: { body?: unknown } }).table;
  const own = table !== undefined && Array.isArray(table.body) ? [table.body as TableBody] : [];
  return [...own, ...Object.values(node).flatMap(tableBodies)];
}

/** The printed text of one table cell, its pieces joined: only `text` is read, not styling such as colours and alignment. */
export function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (Array.isArray(cell)) return cell.map(cellText).join('');
  if (typeof cell === 'object' && cell !== null && 'text' in cell) return cellText((cell as { text: unknown }).text);
  return '';
}
