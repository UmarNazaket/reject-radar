import { sql } from 'drizzle-orm';

/** `column in ('a', 'b')` built from a contracts union, so the database enforces the same values as the code. */
export const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);
