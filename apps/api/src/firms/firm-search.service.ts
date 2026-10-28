import { Inject, Injectable } from '@nestjs/common';
import type { FirmSearchLabel, FirmSearchQuery, FirmSearchResponse, FirmSearchResult } from '@rejectradar/contracts';
import { type Database } from '@rejectradar/db';
import { labelQueryScore, MATCH_CONFIG, normalizeCity, normalizeName, type QueryEvidence } from '@rejectradar/matching';
import { sql } from 'drizzle-orm';
import { DB } from '../database/database.module';

/** What the score of a result was made from. `byFei` marks a firm found by its FEI, whose score is 1 whatever the name. */
export interface FirmSearchEvidence extends QueryEvidence {
  byFei: boolean;
}

export interface FirmSearchHit extends FirmSearchResult {
  evidence: FirmSearchEvidence;
}

type CandidateRow = {
  id: string | number;
  displayName: string;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  commodityIds: number[];
  lastNoticeOn: string | null;
  sim: number;
  cityMatch: boolean;
  uniqueNearExact: boolean;
  score: number;
}

type FirmRow = Omit<CandidateRow, 'sim' | 'cityMatch' | 'uniqueNearExact' | 'score'>;

/** The columns a result shows; the dates leave the database as text, so no driver conversion is involved. */
const FIRM_COLUMNS = sql`f.id, f.display_name as "displayName", f.country_code as "countryCode", f.city, f.region,
  f.commodity_ids as "commodityIds", to_char(f.last_notice_on, 'YYYY-MM-DD') as "lastNoticeOn"`;

/**
 * Firm search (spec §8.3, P5-D8). The score is computed in SQL from `MATCH_CONFIG.query` and must equal
 * `queryScore` of the same evidence exactly (the spec proves it). Firms are reference data and searching uses no
 * lookup, so nothing here depends on the account.
 */
@Injectable()
export class FirmSearchService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async search(query: FirmSearchQuery): Promise<FirmSearchResponse> {
    const hits = await this.searchWithEvidence(query);
    return { results: hits.map((hit) => toResult(hit, hit.label, hit.score)) };
  }

  /** At most `MATCH_CONFIG.query.limit` results, best first, each with the evidence its score is made from. */
  async searchWithEvidence(query: FirmSearchQuery): Promise<FirmSearchHit[]> {
    if (query.fei !== undefined) {
      const byFei = await this.findByFei(query.fei);
      if (byFei) return [byFei];
    }
    if (query.name === undefined) return [];
    // A name of only legal words (`Pvt Ltd`) normalises to nothing and has nothing to search for.
    const name = normalizeName(query.name).primary;
    if (name === '') return [];
    return this.findByName(name, query.country ?? null, normalizeCity(query.city));
  }

  /** A firm's FEI goes straight to it (a merged-away firm to the one it was merged into): score 1, strong. */
  private async findByFei(fei: string): Promise<FirmSearchHit | null> {
    const { rows } = await this.db.execute<FirmRow>(sql`
      select ${FIRM_COLUMNS}
      from firm_fei
      join firm f on f.id = coalesce((select a.new_id from firm_alias a where a.old_id = firm_fei.firm_id), firm_fei.firm_id)
      where firm_fei.fei = ${fei}::bigint`);
    if (rows.length === 0) return null;
    const label: FirmSearchLabel = 'strong';
    return { ...toResult(rows[0], label, 1), evidence: { sim: 1, cityMatch: false, uniqueNearExact: false, byFei: true } };
  }

  private async findByName(name: string, country: string | null, city: string | null): Promise<FirmSearchHit[]> {
    const cfg = MATCH_CONFIG.query;
    // `%` is pg_trgm's operator at its default threshold of 0.3 and uses the GIN index; the threshold is never `SET`
    // (a session-level setting does not survive Neon's pooler). Firms merged into another are not candidates.
    const { rows } = await this.db.execute<CandidateRow>(sql`
      with c as (
        select ${FIRM_COLUMNS},
               similarity(f.name_norm, ${name}::text)::float8 as sim,
               coalesce(f.city = ${city}::text, false) as city_match
        from firm f
        where f.name_norm % ${name}::text
          and (${country}::text is null or f.country_code = ${country}::text)
          and not exists (select 1 from firm_alias a where a.old_id = f.id)
      ), u as (
        select *, count(*) filter (where sim >= ${cfg.uniqueMinSim}::float8) over () as near_exact from c
      )
      select id, "displayName", "countryCode", city, region, "commodityIds", "lastNoticeOn", sim,
             city_match as "cityMatch",
             (sim >= ${cfg.uniqueMinSim}::float8 and near_exact = 1) as "uniqueNearExact",
             least(1, round(((${cfg.name}::float8 * sim)
               + (case when city_match then ${cfg.city}::float8 else 0 end)
               + (case when sim >= ${cfg.uniqueMinSim}::float8 and near_exact = 1 then ${cfg.unique}::float8 else 0 end))::numeric, 4))::float8 as score
      from u
      order by score desc, id asc
      limit ${cfg.limit}::int`);
    return rows.flatMap((row) => {
      const label = labelQueryScore(row.score);
      if (label === 'hidden') return [];
      return [
        {
          ...toResult(row, label, row.score),
          evidence: { sim: row.sim, cityMatch: row.cityMatch, uniqueNearExact: row.uniqueNearExact, byFei: false },
        },
      ];
    });
  }
}

/** The fields of a result, and nothing else a row or hit may carry. */
function toResult(row: Pick<FirmSearchResult, 'id' | 'displayName' | 'countryCode' | 'city' | 'region' | 'commodityIds' | 'lastNoticeOn'> | FirmRow, label: FirmSearchLabel, score: number): FirmSearchResult {
  return {
    id: Number(row.id),
    displayName: row.displayName,
    countryCode: row.countryCode,
    city: row.city,
    region: row.region,
    commodityIds: row.commodityIds,
    lastNoticeOn: row.lastNoticeOn,
    label,
    score,
  };
}
