import { fdaChargeCode } from '@rejectradar/db';
import { classifyHazards, UNCLASSIFIED_ID } from '@rejectradar/taxonomy';
import { sql } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import type { SyncDeps } from '../../core/deps';
import { runSync, type SyncRunResult } from '../../core/sync-run';

export const FDA_CHARGE_CODES_URL = 'https://datadashboard.fda.gov/oii/download/ACT_SECTION_CHARGES.CSV';

export interface ChargeCode {
  /** FDA's `ASC_ID`: the number that `RefusalCharges` lists. */
  code: string;
  /** FDA's `CHRG_CODE`, a short mnemonic such as `SALMONELLA`. */
  name: string;
  section: string | null;
  description: string | null;
}

const text = (value: unknown): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
};

export function parseChargeCodes(csv: string): ChargeCode[] {
  const rows = parse(csv, { bom: true, columns: true, relax_quotes: true, skip_empty_lines: true, trim: true }) as Record<string, unknown>[];
  const byCode = new Map<string, ChargeCode>();
  for (const row of rows) {
    const code = text(row['ASC_ID']);
    const name = text(row['CHRG_CODE']);
    if (code === null || name === null) throw new Error(`Charge-code file: row without ASC_ID or CHRG_CODE: ${JSON.stringify(row).slice(0, 200)}`);
    byCode.set(code, { code, name, section: text(row['SCTN_NAME']), description: text(row['CHRG_STMNT_TEXT']) });
  }
  return [...byCode.values()];
}

const BATCH_SIZE = 500;

/** Loads FDA's charge-code reference file, with each code's hazard (null when no hazard rule matches). */
export async function syncChargeCodes(deps: SyncDeps): Promise<SyncRunResult> {
  return runSync(deps.db, 'fda_charge_codes', async (ctx) => {
    const response = await deps.fetcher(FDA_CHARGE_CODES_URL, { expect: 'csv' });
    ctx.setOrigin(FDA_CHARGE_CODES_URL, response.sha256);
    const codes = parseChargeCodes(response.text());
    ctx.counts.rowsRead = codes.length;

    const rows = codes.map((c) => {
      const [first] = classifyHazards(deps.rules, 'fda_charge_code', {
        charge: [`${c.name} ${c.description ?? ''}`.trim()],
        code: [c.name],
      });
      return { ...c, hazardId: first === UNCLASSIFIED_ID ? null : first };
    });

    await deps.db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const returned = await tx
          .insert(fdaChargeCode)
          .values(rows.slice(i, i + BATCH_SIZE))
          .onConflictDoUpdate({
            target: fdaChargeCode.code,
            set: {
              name: sql`excluded.name`,
              section: sql`excluded.section`,
              description: sql`excluded.description`,
              hazardId: sql`excluded.hazard_id`,
            },
            setWhere: sql`(${fdaChargeCode.name}, ${fdaChargeCode.section}, ${fdaChargeCode.description}, ${fdaChargeCode.hazardId})
              is distinct from (excluded.name, excluded.section, excluded.description, excluded.hazard_id)`,
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        for (const row of returned) {
          if (row.inserted) ctx.counts.rowsInserted++;
          else ctx.counts.rowsUpdated++;
        }
      }
    });
  });
}
