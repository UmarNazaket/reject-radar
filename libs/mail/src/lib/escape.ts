const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}
