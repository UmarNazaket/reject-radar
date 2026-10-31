import type { Database } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * The account tables (P11), parents before children: what people and staff made, which the syncs cannot rebuild.
 * Sessions, one-time tokens and email logs are left out; reference data (records, firms, taxonomy) comes back from
 * the syncs or a copy, and must be in place before a restore, since watchlists and alerts point at it.
 */
export const BACKUP_TABLES = [
  'org',
  'app_user',
  'membership',
  'invite',
  'subscription',
  'paddle_event',
  'lookup_log',
  'usage_counter',
  'watchlist_item',
  'alert',
  'alert_email',
  'notification_pref',
  'bulk_job',
  'bulk_job_row',
  'dispute',
  'audit_log',
  'api_key',
] as const;

/** The tables whose `id` is an identity column, so a restore moves their sequences past the restored ids. */
const IDENTITY_TABLES = ['bulk_job_row', 'audit_log'] as const;

const INSERT_BATCH = 1000;

type Counts = Record<(typeof BACKUP_TABLES)[number], number>;

const isBackupTable = (name: unknown): name is (typeof BACKUP_TABLES)[number] => (BACKUP_TABLES as readonly unknown[]).includes(name);

/** Writes every account table to `file`, gzipped, one `{"table","row"}` line per row, from one read-only snapshot. */
export async function backupApp(db: Database, file: string): Promise<Counts> {
  const counts = {} as Counts;
  const lines: string[] = [];
  await db.transaction(
    async (tx) => {
      for (const table of BACKUP_TABLES) {
        const { rows } = await tx.execute<{ row: string }>(sql`select row_to_json(t)::text as row from ${sql.identifier(table)} t`);
        counts[table] = rows.length;
        for (const { row } of rows) lines.push(`{"table":"${table}","row":${row}}\n`);
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  await pipeline(Readable.from(lines), createGzip(), createWriteStream(file));
  return counts;
}

/**
 * Puts a `backupApp` file back, in one transaction, into a database on the same schema version whose account tables
 * are empty; it refuses otherwise, so it never mixes a backup with live rows. Postgres converts the values itself.
 */
export async function restoreApp(db: Database, file: string): Promise<Counts> {
  const rows = new Map<string, string[]>(BACKUP_TABLES.map((table) => [table, []]));
  for await (const line of createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (!line) continue;
    const { table, row } = JSON.parse(line) as { table: unknown; row: unknown };
    if (!isBackupTable(table)) throw new Error(`The backup holds a table that is not restored: ${String(table)}`);
    rows.get(table)?.push(JSON.stringify(row));
  }

  const counts = {} as Counts;
  await db.transaction(async (tx) => {
    for (const table of BACKUP_TABLES) {
      const { rows: found } = await tx.execute<{ any: boolean }>(sql`select exists (select 1 from ${sql.identifier(table)}) as any`);
      if (found[0]?.any) throw new Error(`${table} already has rows; restore only into empty account tables`);
    }
    for (const table of BACKUP_TABLES) {
      const all = rows.get(table) ?? [];
      for (let i = 0; i < all.length; i += INSERT_BATCH) {
        const json = `[${all.slice(i, i + INSERT_BATCH).join(',')}]`;
        await tx.execute(sql`insert into ${sql.identifier(table)} overriding system value select * from json_populate_recordset(null::${sql.identifier(table)}, ${json}::json)`);
      }
      counts[table] = all.length;
    }
    for (const table of IDENTITY_TABLES) {
      await tx.execute(sql`select setval(pg_get_serial_sequence(${table}, 'id'), coalesce(max(id), 0) + 1, false) from ${sql.identifier(table)}`);
    }
  });
  return counts;
}
