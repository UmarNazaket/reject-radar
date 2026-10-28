import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  MrlComparison,
  MrlLimit,
  MrlNotice,
  MrlQuery,
  MrlResponse,
  ResidueSearchResponse,
} from '@rejectradar/contracts';
import { commodityWithin, type Database } from '@rejectradar/db';
import { foldToAscii } from '@rejectradar/matching';
import { sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { escapeLike } from '../common/like';
import { DB } from '../database/database.module';

const MAX_RESIDUES = 20;
const MAX_NOTICES = 10;
const TODAY = sql`(now() at time zone 'utc')::date`;

type LimitRow = { productCode: string; productName: string; mrlMgKg: string | null; isLod: boolean; legalRef: string | null; applicableFrom: string | null };
// Row types are `type` aliases: `execute` wants an index signature, which an interface lacks.
type ResidueRow = { id: string; name: string; nameNorm: string };
type NoticeRow = { reference: string; notifiedOn: string; subject: string; originCountries: string[]; url: string | null };

/** The lab value against the limit; no numeric limit (or no lab value) means no comparison. */
export function compare(lab: number | undefined, limit: number | null): MrlComparison | null {
  if (lab === undefined || limit === null) return null;
  return lab > limit ? 'above' : 'at_or_below';
}

/** The EU MRL checker (roadmap 5.7): residue search, limits of a commodity and the RASFF notices naming the residue. All reference data. */
@Injectable()
export class MrlService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Names are stored as `foldToAscii(name).toLowerCase()`, so the text is folded the same way. Best first: prefix matches, then similarity. */
  async searchResidues(q: string): Promise<ResidueSearchResponse> {
    const folded = foldToAscii(q).toLowerCase();
    const prefix = `${escapeLike(folded)}%`;
    // `%` is pg_trgm's operator at its default threshold; it is never `SET` (a session-level setting does not survive Neon's pooler).
    const { rows } = await this.db.execute<ResidueRow>(sql`
      select id, name, name_norm as "nameNorm"
      from eu_pesticide_residue
      where name_norm like ${prefix}::text or name_norm % ${folded}::text
      order by (name_norm like ${prefix}::text) desc, similarity(name_norm, ${folded}::text) desc, name asc, id asc
      limit ${MAX_RESIDUES}::int`);
    return { residues: rows.map((row) => ({ id: row.id, name: row.name })) };
  }

  async check(query: MrlQuery): Promise<MrlResponse> {
    const residue = await this.findResidue(query.residue);
    const productCodes = await this.productCodes(query.commodity);
    const [limits, notices] = await Promise.all([
      this.limits(productCodes, residue.id, query.lab),
      this.notices(query.commodity, residue.nameNorm),
    ]);
    return { commodityId: query.commodity, residue: { id: residue.id, name: residue.name }, productCodes, limits, notices };
  }

  private async findResidue(id: string): Promise<ResidueRow> {
    const { rows } = await this.db.execute<ResidueRow>(
      sql`select id, name, name_norm as "nameNorm" from eu_pesticide_residue where id = ${id}::text`,
    );
    if (rows.length === 0) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Residue not found.');
    return rows[0];
  }

  /** The commodity's own EU product codes, else those of its nearest ancestor that has any (read-only reference join on `commodity`). */
  private async productCodes(commodityId: number): Promise<string[]> {
    const known = await this.db.execute<{ id: number }>(sql`select id from commodity where id = ${commodityId}::int`);
    if (known.rows.length === 0) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Commodity not found.');
    const { rows } = await this.db.execute<{ codes: string[] }>(sql`
      select x.eu_mrl_codes as codes
      from commodity c
      cross join lateral unnest(array[c.id] || c.ancestor_ids) with ordinality as a(id, ord)
      join commodity x on x.id = a.id
      where c.id = ${commodityId}::int and cardinality(x.eu_mrl_codes) > 0
      order by a.ord
      limit 1`);
    return rows[0]?.codes ?? [];
  }

  private async limits(productCodes: string[], residueId: string, lab: number | undefined): Promise<MrlLimit[]> {
    if (productCodes.length === 0) return [];
    const { rows } = await this.db.execute<LimitRow>(sql`
      select m.product_code as "productCode", p.name as "productName", m.mrl_mg_kg::text as "mrlMgKg", m.is_lod as "isLod",
             m.legal_ref as "legalRef", to_char(m.applicable_from, 'YYYY-MM-DD') as "applicableFrom"
      from eu_mrl m
      join eu_mrl_product p on p.code = m.product_code
      where m.residue_id = ${residueId}::text and m.product_code in (${sql.join(productCodes.map((code) => sql`${code}`), sql`, `)})
      order by m.product_code`);
    return rows.map((row) => {
      const mrlMgKg = row.mrlMgKg === null ? null : Number(row.mrlMgKg);
      return { ...row, mrlMgKg, comparison: compare(lab, mrlMgKg) };
    });
  }

  /** The latest RASFF notices of the last three years for the commodity or below whose hazards name the residue. */
  private async notices(commodityId: number, residueNameNorm: string): Promise<MrlNotice[]> {
    const pattern = `%${escapeLike(residueNameNorm)}%`;
    const { rows } = await this.db.execute<NoticeRow>(sql`
      select r.reference, to_char(r.notified_on, 'YYYY-MM-DD') as "notifiedOn", r.subject,
             r.origin_countries as "originCountries", r.url
      from rasff_notification r
      where ${commodityWithin(sql`r.commodity_id`, commodityId)}
        and r.notified_on >= ${TODAY} - interval '3 years'
        and exists (select 1 from jsonb_array_elements(r.hazards) h where lower(h->>'name') like ${pattern}::text)
      order by r.notified_on desc, r.reference desc
      limit ${MAX_NOTICES}::int`);
    return rows.map((row) => ({
      reference: row.reference,
      notifiedOn: row.notifiedOn,
      subject: row.subject,
      originCountries: row.originCountries,
      url: row.url,
    }));
  }
}
