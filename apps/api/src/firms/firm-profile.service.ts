import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type FirmAddress,
  type FirmAuFailure,
  type FirmFlags,
  firmFlagsSchema,
  type FirmListing,
  type FirmMetrics,
  firmMetricsSchema,
  type FirmProfileResponse,
  type FirmRefusal,
} from '@rejectradar/contracts';
import { type Database } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { FreshnessService } from '../notices/freshness.service';

/** The facts of a firm that has none yet (its aggregates have not been refreshed), which is the facts of a firm without records. */
const NO_FLAGS: FirmFlags = {
  import_alert_red: [],
  import_alert_green: [],
  fda_refusals_12m: 0,
  fda_refusals_3y: 0,
  au_failed_3y: 0,
  au_holding_order: false,
  top_hazards_3y: [],
};
const NO_METRICS: FirmMetrics = { fda_refusals_total: 0, au_failed_total: 0, import_alert_red_current: 0, import_alert_green_current: 0 };

/** What a list of firms (the watchlist) shows of each. */
export interface FirmSummary {
  id: number;
  displayName: string;
  countryCode: string | null;
  facts: FirmFlags;
  /** `YYYY-MM-DD`. */
  lastNoticeOn: string | null;
}

type FirmRow = {
  id: string | number;
  displayName: string;
  altNames: string[];
  feis: string[];
  countryCode: string | null;
  region: string | null;
  postalCode: string | null;
  commodityIds: number[];
  firstSeen: string | null;
  lastNoticeOn: string | null;
  flags: unknown;
  metrics: unknown;
};

type RefusalRow = Omit<FirmRefusal, 'id'> & { id: string | number };
type ListingRow = Omit<FirmListing, 'id'> & { id: string | number };
type AuRow = Omit<FirmAuFailure, 'id'> & { id: string | number };

/** `{}` is what a firm has before its first refresh; anything else must be what the refresh writes. */
const isUnset = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.keys(value).length === 0;

/** Dates leave the database as text, so no driver conversion is involved. */
/** `column` is always one of this file's own column names, never user input. */
const day = (column: string) => sql.raw(`to_char(${column}, 'YYYY-MM-DD')`);

/**
 * The firm profile (spec §9.4, P5-D9, P5-D10). Firms are reference data; the only thing that belongs to the caller's
 * account is the lookup, which `EntitlementsService` charges.
 */
@Injectable()
export class FirmProfileService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly freshness: FreshnessService,
  ) {}

  /**
   * The firm that `id` stands for: itself, or the one it was merged into (`firm_alias` is one hop, because a merge
   * re-points the older aliases). Null when there is no such firm. The watchlist and `alerts:run` resolve ids the same way.
   */
  async resolveId(id: number): Promise<number | null> {
    const { rows } = await this.db.execute<{ id: string | number }>(sql`
      select f.id from firm f
      where f.id = coalesce((select a.new_id from firm_alias a where a.old_id = ${id}::bigint), ${id}::bigint)`);
    return rows.length === 0 ? null : Number(rows[0].id);
  }

  /** The profile of the firm `id` stands for, charging the caller's account one lookup unless it opened that firm this month. */
  async profile(ctx: Pick<RequestContext, 'orgId'>, id: number): Promise<FirmProfileResponse> {
    // The firm is read, and its stored facts checked, before the lookup is charged, so a missing or unreadable firm costs nothing.
    const firm = await this.readFirm(id);
    if (firm === null) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    const firmId = Number(firm.id);
    const facts = isUnset(firm.flags) ? NO_FLAGS : firmFlagsSchema.parse(firm.flags);
    const metrics = isUnset(firm.metrics) ? NO_METRICS : firmMetricsSchema.parse(firm.metrics);

    const lookup = await this.entitlements.chargeLookup(ctx.orgId, firmId);
    const [refusals, listings, auFailures, address, freshness] = await Promise.all([
      this.refusals(firmId),
      this.listings(firmId),
      this.auFailures(firmId),
      this.address(firmId, firm),
      this.freshness.all(),
    ]);
    return {
      id: firmId,
      displayName: firm.displayName,
      altNames: firm.altNames,
      feis: firm.feis,
      address,
      commodityIds: firm.commodityIds,
      firstSeen: firm.firstSeen,
      lastNoticeOn: firm.lastNoticeOn,
      facts,
      metrics,
      refusals,
      listings,
      auFailures,
      freshness,
      lookup,
    };
  }

  /** The facts of the firms named (as given: ids of merged-away firms are not followed), by firm id. A firm that does not exist is absent. */
  async summaryFacts(firmIds: readonly number[]): Promise<Map<number, FirmSummary>> {
    if (firmIds.length === 0) return new Map();
    const { rows } = await this.db.execute<Pick<FirmRow, 'id' | 'displayName' | 'countryCode' | 'lastNoticeOn' | 'flags'>>(sql`
      select f.id, f.display_name as "displayName", f.country_code as "countryCode",
             to_char(f.last_notice_on, 'YYYY-MM-DD') as "lastNoticeOn", f.flags
      from firm f
      where f.id = any(${sql.param([...firmIds])}::bigint[])`);
    return new Map(
      rows.map((row) => [
        Number(row.id),
        {
          id: Number(row.id),
          displayName: row.displayName,
          countryCode: row.countryCode,
          facts: isUnset(row.flags) ? NO_FLAGS : firmFlagsSchema.parse(row.flags),
          lastNoticeOn: row.lastNoticeOn,
        },
      ]),
    );
  }

  /** The firm itself, or the one `id` was merged into. */
  private async readFirm(id: number): Promise<FirmRow | null> {
    const { rows } = await this.db.execute<FirmRow>(sql`
      select f.id, f.display_name as "displayName", f.alt_names as "altNames",
             coalesce((select array_agg(e.fei::text order by e.fei) from firm_fei e where e.firm_id = f.id), '{}'::text[]) as feis,
             f.country_code as "countryCode", f.region, f.postal_code as "postalCode", f.commodity_ids as "commodityIds",
             ${day('f.first_seen')} as "firstSeen", ${day('f.last_notice_on')} as "lastNoticeOn",
             f.flags, f.metrics
      from firm f
      where f.id = coalesce((select a.new_id from firm_alias a where a.old_id = ${id}::bigint), ${id}::bigint)`);
    return rows[0] ?? null;
  }

  /** Newest first. Each charge carries the name FDA gives its code, if the code is in FDA's list. */
  private async refusals(firmId: number): Promise<FirmRefusal[]> {
    const { rows } = await this.db.execute<RefusalRow>(sql`
      select r.id, ${day('r.refusal_date')} as "refusalDate", r.product_code as "productCode", r.product_desc as "productDesc",
             coalesce((
               select jsonb_agg(jsonb_build_object('code', c.code, 'name', cc.name, 'description', cc.description) order by c.position)
               from unnest(r.charge_codes) with ordinality as c (code, position)
               left join fda_charge_code cc on cc.code = c.code
             ), '[]'::jsonb) as charges,
             r.fda_sample_analysis as "fdaSampleAnalysis", r.private_lab_analysis as "privateLabAnalysis", n.url
      from fda_refusal r
      left join notice n on n.source = 'fda_refusal' and n.source_key = r.source_key
      where r.firm_id = ${firmId}::bigint
      order by r.refusal_date desc, r.id desc`);
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  /** Newest first, with the products each listing names. The link is the red listing's notice, else the alert's own page. */
  private async listings(firmId: number): Promise<FirmListing[]> {
    const { rows } = await this.db.execute<ListingRow>(sql`
      select l.id, l.alert_number as "alertNumber", a.title as "alertTitle", l.list,
             ${day('l.listed_on')} as "listedOn", ${day('l.removed_on')} as "removedOn",
             coalesce(n.url, a.url) as url,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                 'productCode', p.product_code, 'productName', p.product_name, 'description', p.description,
                 'listedOn', ${day('p.listed_on')}, 'notes', p.notes, 'removedOn', ${day('p.removed_on')}
               ) order by p.position nulls last, p.id)
               from import_alert_listing_product p where p.listing_id = l.id
             ), '[]'::jsonb) as products
      from import_alert_listing l
      join import_alert a on a.number = l.alert_number
      left join notice n on n.source = 'import_alert' and n.source_key = l.listing_key
      where l.firm_id = ${firmId}::bigint
      order by coalesce(l.listed_on, l.first_seen_on) desc, l.id desc`);
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  /** Newest first, dated by the failure, else by its report month. */
  private async auFailures(firmId: number): Promise<FirmAuFailure[]> {
    const { rows } = await this.db.execute<AuRow>(sql`
      select a.id, ${day('a.failed_on')} as "failedOn", to_char(a.report_month, 'YYYY-MM') as "reportMonth",
             a.product_desc as "productDesc", a.test_applied as "testApplied", a.reason, a.result_text as "resultText",
             a.holding_order_match as "holdingOrderMatch", n.url
      from au_failing_food a
      left join notice n on n.source = 'au_ifis' and n.source_key = a.source_key
      where a.firm_id = ${firmId}::bigint
      order by coalesce(a.failed_on, a.report_month) desc, a.id desc`);
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  /**
   * The address as the latest record that carries one published it (P5-D10): an FDA refusal's two address lines, or a
   * listing's address as the Import Alert page writes it (Australian records have none). `firm.city` is stored
   * normalised for matching and is never shown. A firm none of whose records has an address shows its own country,
   * region and postal code.
   */
  private async address(firmId: number, firm: Pick<FirmRow, 'countryCode' | 'region' | 'postalCode'>): Promise<FirmAddress> {
    const { rows } = await this.db.execute<FirmAddress & Record<string, unknown>>(sql`
      select line, city, region, postal_code as "postalCode", country_code as "countryCode"
      from (
        select r.refusal_date as seen_on, 0 as rank, r.id,
               nullif(concat_ws(', ', nullif(trim(r.address_line1), ''), nullif(trim(r.address_line2), '')), '') as line,
               nullif(trim(r.city), '') as city, nullif(trim(r.region), '') as region,
               nullif(trim(r.postal_code), '') as postal_code, r.country_code
        from fda_refusal r where r.firm_id = ${firmId}::bigint
        union all
        select coalesce(l.listed_on, l.first_seen_on), 1, l.id,
               nullif(trim(l.address_raw), ''), nullif(trim(l.city), ''), nullif(trim(l.region), ''), null, l.country_code
        from import_alert_listing l where l.firm_id = ${firmId}::bigint
      ) published
      where line is not null or city is not null or region is not null or postal_code is not null
      order by seen_on desc, rank, id desc
      limit 1`);
    const latest = rows[0];
    if (latest === undefined) {
      return { line: null, city: null, region: firm.region, postalCode: firm.postalCode, countryCode: firm.countryCode };
    }
    return { ...latest, countryCode: latest.countryCode ?? firm.countryCode };
  }
}
