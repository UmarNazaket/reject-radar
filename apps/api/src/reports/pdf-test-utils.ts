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
