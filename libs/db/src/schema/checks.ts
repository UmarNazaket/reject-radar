import { sql } from 'drizzle-orm';

/**
 * One value as SQL. drizzle-kit cuts a generated statement at a `;`, even one inside a string literal (the snapshot keeps
 * it, the migration loses the rest of the line), so a lone semicolon is written as `chr(59)`.
 */
const literal = (value: string) => (value === ';' ? 'chr(59)' : `'${value}'`);

/** `column in ('a', 'b')` built from a contracts union, so the database enforces the same values as the code. */
export const oneOf = (column: string, values: readonly string[]) => sql.raw(`${column} in (${values.map(literal).join(', ')})`);
