import { firm } from '@rejectradar/db';
import { isUsableName, normalizeName } from '@rejectradar/matching';
import { type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from './types';

/** At most this many alternative names per firm (P3-D6). */
const MAX_ALT_NAMES = 20;
/** Firms per `update … from (values …)`. */
const UPDATE_BATCH = 1000;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Sets `alt_names` on each of `firmIds` (P3-D6): the other raw names its records give the firm, compared without case
 * and spelt as first seen; only names that normalise to a usable name, never the display name; sorted by code unit, at
 * most 20. A firm is written only when its names changed. Returns how many firms were written.
 */
export async function refreshFirmAltNames(tx: DbOrTx, firmIds: readonly number[]): Promise<number> {
  if (firmIds.length === 0) return 0;
  const ids = sql`${sql.param([...firmIds])}::bigint[]`;
  const firms = await tx
    .select({ id: firm.id, displayName: firm.displayName, altNames: firm.altNames })
    .from(firm)
    .where(sql`${firm.id} = any(${ids})`);
  const rawNames = await recordNames(tx, ids);
  const changed = firms.flatMap(({ id, displayName, altNames }) => {
    const names = altNamesOf(displayName, rawNames.get(id) ?? []);
    return sameNames(names, altNames) ? [] : [{ id, names }];
  });

  let written = 0;
  for (const batch of chunks(changed, UPDATE_BATCH)) {
    const values = sql.join(
      batch.map(({ id, names }) => sql`(${id}::bigint, ${sql.param(names)}::text[])`),
      sql`, `,
    );
    const result = await tx.execute(sql`
      update firm set alt_names = v.alt_names, updated_at = now()
      from (values ${values}) as v (id, alt_names)
      where firm.id = v.id`);
    written += result.rowCount ?? 0;
  }
  return written;
}

/**
 * The raw names of the records of the firms in `ids`, per firm, each once and in the order first seen: FDA refusals,
 * then Import Alert listings, then Australian failed tests, each in stored order.
 */
async function recordNames(tx: DbOrTx, ids: SQL): Promise<Map<number, string[]>> {
  const { rows } = await tx.execute<{ firm_id: string; name: string }>(sql`
    with targets (id) as (select unnest(${ids}))
    select firm_id, name
    from (
      select distinct on (firm_id, name) firm_id, name, source_rank, id
      from (
        select firm_id, firm_name as name, 1 as source_rank, id
        from fda_refusal where firm_id in (select id from targets)
        union all
        select firm_id, firm_name, 2, id
        from import_alert_listing where firm_id in (select id from targets)
        union all
        select firm_id, producer_name, 3, id
        from au_failing_food where firm_id in (select id from targets) and producer_name is not null
      ) records
      order by firm_id, name, source_rank, id
    ) first_records
    order by firm_id, source_rank, id`);
  const names = new Map<number, string[]>();
  for (const { firm_id, name } of rows) {
    // A bigint comes back as text.
    const id = Number(firm_id);
    const held = names.get(id);
    if (held) held.push(name);
    else names.set(id, [name]);
  }
  return names;
}

/** P3-D6 for one firm, from its records' raw names in the order first seen. */
function altNamesOf(displayName: string, rawNames: readonly string[]): string[] {
  const seen = new Set([displayName.toLowerCase()]);
  const kept: string[] = [];
  for (const name of rawNames) {
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (isUsableName(normalizeName(name).primary)) kept.push(name);
  }
  // Without a compare function, sort orders by code unit.
  return kept.sort().slice(0, MAX_ALT_NAMES);
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}
