/** Escapes `\`, `%` and `_` so user text matches literally inside a `LIKE` or `ILIKE` pattern (backslash is the default escape). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
