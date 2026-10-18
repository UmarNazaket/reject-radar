import type { SyncSource } from '@rejectradar/contracts';
import { sourceFile, type Database } from '@rejectradar/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from './sync-run';

/** The hash a file had when it was last loaded, or null when it never was. */
export async function loadedFile(db: Database | Tx, source: SyncSource, url: string): Promise<{ sha256: string } | null> {
  const [row] = await db
    .select({ sha256: sourceFile.sha256 })
    .from(sourceFile)
    .where(and(eq(sourceFile.source, source), eq(sourceFile.url, url)));
  return row ?? null;
}

/** Notes that a file (with this hash and row count) is now loaded; replaces any earlier record of the same file. */
export async function recordFile(tx: Tx, source: SyncSource, url: string, sha256: string, rows: number): Promise<void> {
  await tx
    .insert(sourceFile)
    .values({ source, url, sha256, rows })
    .onConflictDoUpdate({
      target: [sourceFile.source, sourceFile.url],
      set: { sha256: sql`excluded.sha256`, rows: sql`excluded.rows`, loadedAt: sql`now()` },
    });
}

export interface MonthlyResource {
  url: string;
  name: string;
  /** `YYYY-MM`, from the month and year in the resource name. */
  month: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const MONTH_IN_NAME = new RegExp(`(${MONTHS.join('|')})\\s+(\\d{4})`, 'i');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The monthly CSV files of a CKAN `package_show` response, oldest month first. A resource counts when its format is CSV
 * (`CSV`, `csv` or `.csv`) and its name holds a month and a year, such as "Border Notifications - April 2026". A CSV
 * resource without one is skipped with a warning naming it, then a count of them all, so a renamed file never vanishes
 * silently.
 */
export function listMonthlyCsvResources(packageJson: unknown): MonthlyResource[] {
  const resources = isRecord(packageJson) && isRecord(packageJson['result']) ? packageJson['result']['resources'] : undefined;
  if (!Array.isArray(resources)) throw new Error('CKAN package response has no result.resources list');

  const found: MonthlyResource[] = [];
  let skipped = 0;
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const format = typeof resource['format'] === 'string' ? resource['format'].trim().replace(/^\./, '').toLowerCase() : '';
    if (format !== 'csv') continue;
    const name = typeof resource['name'] === 'string' ? resource['name'].trim() : '';
    const url = typeof resource['url'] === 'string' ? resource['url'].trim() : '';
    const match = MONTH_IN_NAME.exec(name);
    if (!match) {
      skipped++;
      console.warn(`CKAN CSV resource skipped, no "Month YYYY" in its name: "${name}" (${url})`);
      continue;
    }
    if (url === '') throw new Error(`CKAN resource "${name}" has no url`);
    const month = MONTHS.findIndex((m) => m.toLowerCase() === match[1].toLowerCase()) + 1;
    found.push({ url, name, month: `${match[2]}-${String(month).padStart(2, '0')}` });
  }
  if (skipped > 0) console.warn(`${skipped} CKAN CSV resource${skipped === 1 ? '' : 's'} skipped for want of a month and year in the name`);
  return found.sort((a, b) => a.month.localeCompare(b.month) || a.url.localeCompare(b.url));
}
